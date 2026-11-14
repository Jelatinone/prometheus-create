/**
 * CT-002 — common ingestion envelope and reconstruction jobs.
 *
 * Every adapter (upload, phone camera, Chert) submits the same envelope for
 * each frame. Large media goes straight to private storage first; the API
 * receives metadata only, never a base64 clip.
 *
 * Idempotency: (sourceId, sequence). Same sequence + same contentHash is a
 * duplicate (returns the original observation); same sequence with
 * different content is a DUPLICATE error. Out-of-order frames are stored but
 * never move "latest" backwards. Stale preview frames are dropped.
 */
import { z } from "zod";
import {
  AssetId,
  CaptureSessionId,
  ContentHash,
  ContractError,
  JobId,
  ObjectId,
  ObservationId,
  ProjectId,
  SchemaVersion,
  SourceId,
  Timestamp,
  err,
  ok,
  type Result,
} from "./common";
import { FrameRef, ObservationMode, SourceAdapter, type Source } from "./source";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const IngestEnvelope = z.strictObject({
  schemaVersion: SchemaVersion,
  projectId: ProjectId,
  sourceId: SourceId,
  adapter: SourceAdapter,
  captureSessionId: CaptureSessionId.nullable(),
  sequence: z.int().nonnegative(),
  /** Presentation timestamp in the source (µs). Images use 0. */
  sourceTimeUs: z.int().nonnegative(),
  /** Device/call wall clock when the frame was captured, if known. */
  capturedAt: Timestamp.nullable(),
  mode: ObservationMode,
  frame: FrameRef,
});
export type IngestEnvelope = z.infer<typeof IngestEnvelope>;

export const IngestResult = z.strictObject({
  status: z.enum(["accepted", "duplicate"]),
  observationId: ObservationId,
  sourceId: SourceId,
  sequence: z.int().nonnegative(),
  outOfOrder: z.boolean(),
  /** Highest sequence accepted for this source after this call. */
  latestSequence: z.int().nonnegative(),
});
export type IngestResult = z.infer<typeof IngestResult>;

// ---------------------------------------------------------------------------
// Limits (PLAN §6 proposed operating limits). Measure; adjust via approval.
// ---------------------------------------------------------------------------

export const INGEST_LIMITS = {
  frameMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  imageSourceMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  videoSourceMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  maxFrameBytes: 15 * 1024 * 1024,
  maxImageSourceBytes: 25 * 1024 * 1024,
  maxVideoSourceBytes: 50 * 1024 * 1024,
  maxVideoDurationUs: 30_000_000,
  maxFrameEdgePx: 8192,
  /** Inference inputs are downscaled to this long edge where supported. */
  inferenceMaxEdgePx: 2048,
  /** Preview frames older than this on arrival are STALE_FRAME. */
  maxPreviewLagMs: 2000,
} as const;

export type IngestLimits = typeof INGEST_LIMITS;

/** Check an envelope's media against limits. */
export function checkFrameLimits(
  envelope: IngestEnvelope,
  limits: IngestLimits = INGEST_LIMITS,
): Result<true> {
  const { frame } = envelope;
  if (!(limits.frameMimeTypes as readonly string[]).includes(frame.mimeType))
    return err("UNSUPPORTED_MEDIA", `frame type ${frame.mimeType} is not supported`, {
      allowed: limits.frameMimeTypes,
    });
  if (frame.byteSize > limits.maxFrameBytes)
    return err("TOO_LARGE", `frame is ${frame.byteSize} bytes`, {
      maxBytes: limits.maxFrameBytes,
    });
  if (Math.max(frame.width, frame.height) > limits.maxFrameEdgePx)
    return err("TOO_LARGE", `frame long edge exceeds ${limits.maxFrameEdgePx}px`);
  return ok(true);
}

/** Check a source registration's media against limits. */
export function checkSourceLimits(
  source: Pick<Source, "media">,
  byteSize: number | null,
  limits: IngestLimits = INGEST_LIMITS,
): Result<true> {
  const media = source.media;
  if (media.kind === "image") {
    if (!(limits.imageSourceMimeTypes as readonly string[]).includes(media.mimeType))
      return err("UNSUPPORTED_MEDIA", `image type ${media.mimeType} is not supported`);
    if (byteSize !== null && byteSize > limits.maxImageSourceBytes)
      return err("TOO_LARGE", `image is ${byteSize} bytes`);
  } else if (media.kind === "video") {
    if (!(limits.videoSourceMimeTypes as readonly string[]).includes(media.mimeType))
      return err("UNSUPPORTED_MEDIA", `video type ${media.mimeType} is not supported`);
    if (byteSize !== null && byteSize > limits.maxVideoSourceBytes)
      return err("TOO_LARGE", `video is ${byteSize} bytes`);
    if (media.durationUs > limits.maxVideoDurationUs)
      return err("TOO_LARGE", `video is longer than ${limits.maxVideoDurationUs / 1e6}s`);
  }
  return ok(true);
}

/** Check that an envelope is consistent with its registered source. */
export function checkEnvelopeAgainstSource(
  envelope: IngestEnvelope,
  source: Source,
): Result<true> {
  if (envelope.projectId !== source.projectId)
    return err("NOT_FOUND", `source ${envelope.sourceId} not found in project`);
  if (envelope.adapter !== source.adapter)
    return err("INVALID_SCHEMA", `adapter ${envelope.adapter} does not match source adapter ${source.adapter}`);
  if (envelope.captureSessionId !== source.captureSessionId)
    return err("INVALID_SCHEMA", "captureSessionId does not match the source");
  const media = source.media;
  if (media.kind === "image") {
    if (envelope.sequence !== 0 || envelope.sourceTimeUs !== 0)
      return err("INVALID_SCHEMA", "image sources have exactly one frame: sequence 0 at 0µs");
  }
  if (media.kind === "video" && envelope.sourceTimeUs > media.durationUs)
    return err("INVALID_SCHEMA", `sourceTimeUs exceeds clip duration ${media.durationUs}µs`);
  if (
    media.kind !== "live_stream" &&
    (envelope.frame.width !== media.width || envelope.frame.height !== media.height)
  )
    return err(
      "INVALID_SCHEMA",
      `frame ${envelope.frame.width}x${envelope.frame.height} differs from source ${media.width}x${media.height}; masks would not align`,
    );
  return ok(true);
}

/** Drop preview frames that arrive too late (backpressure). */
export function checkFreshness(
  envelope: IngestEnvelope,
  receivedAt: Date,
  limits: IngestLimits = INGEST_LIMITS,
): Result<true> {
  if (envelope.mode !== "preview" || envelope.capturedAt === null) return ok(true);
  const lagMs = receivedAt.getTime() - Date.parse(envelope.capturedAt);
  if (lagMs > limits.maxPreviewLagMs)
    return err("STALE_FRAME", `preview frame arrived ${lagMs}ms after capture`, {
      lagMs,
      maxPreviewLagMs: limits.maxPreviewLagMs,
    });
  return ok(true);
}

export type FrameClassification =
  | { kind: "new"; outOfOrder: boolean }
  | { kind: "duplicate"; observationId: string };

/**
 * Classify a frame against what is stored for the same (sourceId, sequence).
 * `existing` is the stored observation at that sequence, if any.
 */
export function classifyFrame(
  envelope: IngestEnvelope,
  existing: { id: string; frame: { contentHash: string } } | undefined,
  latestSequence: number | null,
): Result<FrameClassification> {
  if (existing) {
    if (existing.frame.contentHash === envelope.frame.contentHash)
      return ok({ kind: "duplicate", observationId: existing.id });
    return err("DUPLICATE", `sequence ${envelope.sequence} already holds different content`, {
      existingObservationId: existing.id,
    });
  }
  return ok({
    kind: "new",
    outOfOrder: latestSequence !== null && envelope.sequence < latestSequence,
  });
}

// ---------------------------------------------------------------------------
// Reconstruction / segmentation jobs
// ---------------------------------------------------------------------------

export const JobState = z.enum([
  "queued",
  "submitted",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type JobState = z.infer<typeof JobState>;

export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["submitted", "failed", "canceled"],
  submitted: ["running", "succeeded", "failed", "canceled"],
  running: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function isTerminalJobState(state: JobState): boolean {
  return JOB_TRANSITIONS[state].length === 0;
}

const JobHistoryEntry = z.strictObject({
  number: z.int().min(1),
  state: JobState,
  at: Timestamp,
  providerRequestId: z.string().max(200).nullable(),
  error: ContractError.nullable(),
});

export const ReconstructionJob = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: JobId,
    projectId: ProjectId,
    kind: z.enum(["reconstruct_object", "segment"]),
    state: JobState,
    provider: z.enum(["fal", "meshy", "fixture"]),
    /** e.g. "fal-ai/sam-3/3d-objects". */
    providerModel: z.string().min(1).max(200),
    /** Stored before polling; reconcile before ever submitting again. */
    providerRequestId: z.string().max(200).nullable(),
    /** Hash of the normalized provider input; detects accidental resubmits. */
    inputHash: ContentHash,
    input: z.strictObject({
      observationId: ObservationId,
      maskAssetIds: z.array(AssetId),
      targetObjectId: ObjectId.nullable(),
      /** Geometry revision of the target when the job started (0 = new object). */
      baseGeometryRevision: z.int().nonnegative(),
    }),
    /** Append-only state log; one entry per transition. */
    history: z.array(JobHistoryEntry),
    output: z
      .strictObject({
        meshAssetId: AssetId.nullable(),
        splatAssetId: AssetId.nullable(),
        maskAssetIds: z.array(AssetId),
        /** Provider originals copied to owned storage. */
        rawAssetIds: z.array(AssetId),
      })
      .nullable(),
    error: ContractError.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine((job, ctx) => {
    if (["submitted", "running", "succeeded"].includes(job.state) && job.provider !== "fixture" && !job.providerRequestId)
      ctx.addIssue({
        code: "custom",
        path: ["providerRequestId"],
        message: `a ${job.state} job must record its providerRequestId`,
      });
    if (job.state === "succeeded") {
      if (!job.output)
        ctx.addIssue({ code: "custom", path: ["output"], message: "succeeded job requires output" });
      else if (job.kind === "reconstruct_object" && !job.output.meshAssetId)
        ctx.addIssue({
          code: "custom",
          path: ["output", "meshAssetId"],
          message: "INVALID_GEOMETRY: a succeeded reconstruction must produce a mesh asset",
        });
    }
    if (job.state === "failed" && !job.error)
      ctx.addIssue({ code: "custom", path: ["error"], message: "failed job requires error" });
  });
export type ReconstructionJob = z.infer<typeof ReconstructionJob>;

/** Move a job to a new state, or INVALID_TRANSITION. Pure; returns a copy. */
export function transitionJob(
  job: ReconstructionJob,
  to: JobState,
  at: string,
  patch: Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">> = {},
): Result<ReconstructionJob> {
  if (!JOB_TRANSITIONS[job.state].includes(to))
    return err("INVALID_TRANSITION", `job cannot move from ${job.state} to ${to}`, {
      from: job.state,
      to,
    });
  const next: ReconstructionJob = {
    ...job,
    ...patch,
    state: to,
    updatedAt: at,
    history: [
      ...job.history,
      {
        number: job.history.length + 1,
        state: to,
        at,
        providerRequestId: patch.providerRequestId ?? job.providerRequestId,
        error: patch.error ?? null,
      },
    ],
  };
  const parsed = ReconstructionJob.safeParse(next);
  if (!parsed.success)
    return err("INVALID_TRANSITION", parsed.error.issues.map((i) => i.message).join("; "));
  return ok(parsed.data);
}

/**
 * Whether a job's result may replace the target object's geometry. A
 * canceled or stale completion may still become an asset, but it must not
 * overwrite geometry the user has changed since the job started.
 */
export function canApplyJobResult(
  job: ReconstructionJob,
  currentGeometryRevision: number,
): { apply: boolean; reason: string } {
  if (job.state !== "succeeded") return { apply: false, reason: `job is ${job.state}` };
  if (job.input.baseGeometryRevision !== currentGeometryRevision)
    return {
      apply: false,
      reason: `stale: job started at geometry revision ${job.input.baseGeometryRevision}, object is at ${currentGeometryRevision}`,
    };
  return { apply: true, reason: "result is current" };
}
