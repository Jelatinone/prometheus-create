/**
 * CT-002 (source side) — immutable capture evidence.
 *
 * A Source is one media item (photo, clip) or one live stream (a Chert call
 * or phone camera session). Observations are individual frames of a source
 * at a presentation timestamp. Every adapter — upload, phone camera, Chert —
 * produces the same records; only the transport differs.
 */
import { z } from "zod";
import {
  AssetId,
  CaptureSessionId,
  Confirmation,
  ContentHash,
  ObjectId,
  ObservationId,
  ProjectId,
  Rational,
  SchemaVersion,
  SourceId,
  Timestamp,
  Transform,
} from "./common";

export const SourceAdapter = z.enum([
  "upload", // file picker: image or video
  "phone_camera", // browser camera capture on the phone
  "chert_facetime", // caller video from a Chert FaceTime call via LiveKit
  "fixture", // prepared test/demo media; must stay labeled
]);
export type SourceAdapter = z.infer<typeof SourceAdapter>;

const PixelSize = z.int().positive().max(16384);

/**
 * Pixel dimensions are post-orientation (as displayed). Frame and mask
 * assets are stored orientation-normalized at exactly these dimensions so
 * lasso/mask coordinates map 1:1 onto source pixels.
 */
export const SourceMedia = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    mimeType: z.string().min(3),
    width: PixelSize,
    height: PixelSize,
  }),
  z.strictObject({
    kind: z.literal("video"),
    mimeType: z.string().min(3),
    width: PixelSize,
    height: PixelSize,
    durationUs: z.int().positive(),
    /** Nominal rate if known; phone footage is often variable-frame-rate. */
    nominalFrameRate: Rational.nullable(),
  }),
  z.strictObject({
    kind: z.literal("live_stream"),
    /** Live call dimensions may change (rotation, renegotiation). */
    width: PixelSize.nullable(),
    height: PixelSize.nullable(),
  }),
]);
export type SourceMedia = z.infer<typeof SourceMedia>;

export const Consent = z.strictObject({
  basis: z.enum(["owner_upload", "participant_opt_in", "fixture"]),
  recordedAt: Timestamp,
  note: z.string().max(500).nullable(),
});
export type Consent = z.infer<typeof Consent>;

const sourceFields = {
  schemaVersion: SchemaVersion,
  id: SourceId,
  projectId: ProjectId,
  adapter: SourceAdapter,
  media: SourceMedia,
  /** Stored original media. Null only for live streams. */
  assetId: AssetId.nullable(),
  contentHash: ContentHash.nullable(),
  /** Wall-clock capture time if known (EXIF/call clock); not a media time. */
  capturedAt: Timestamp.nullable(),
  captureSessionId: CaptureSessionId.nullable(),
  consent: Consent,
};

type SourceShape = {
  adapter: SourceAdapter;
  media: SourceMedia;
  assetId: string | null;
  contentHash: string | null;
  captureSessionId: string | null;
};

function checkSource(s: SourceShape, ctx: z.RefinementCtx) {
  const live = s.media.kind === "live_stream";
  if (live && (s.assetId !== null || s.contentHash !== null))
    ctx.addIssue({
      code: "custom",
      path: ["assetId"],
      message: "live_stream sources have no stored asset; frames are observations",
    });
  if (!live && (s.assetId === null || s.contentHash === null))
    ctx.addIssue({
      code: "custom",
      path: ["assetId"],
      message: "image/video sources require assetId and contentHash",
    });
  if (s.adapter === "chert_facetime" && !live)
    ctx.addIssue({
      code: "custom",
      path: ["media", "kind"],
      message: "chert_facetime sources are live_stream",
    });
  if (s.adapter === "chert_facetime" && s.captureSessionId === null)
    ctx.addIssue({
      code: "custom",
      path: ["captureSessionId"],
      message: "chert_facetime sources must reference their capture session",
    });
}

/** Client request to register a source. The client generates the ID. */
export const SourceRegistration = z.strictObject(sourceFields).superRefine(checkSource);
export type SourceRegistration = z.infer<typeof SourceRegistration>;

export const Source = z
  .strictObject({ ...sourceFields, createdAt: Timestamp })
  .superRefine(checkSource);
export type Source = z.infer<typeof Source>;

/**
 * Estimated camera for one observation. A live arrival timestamp is not a
 * camera pose. Pose is camera-to-world; the camera looks down local -Z.
 */
export const CameraEstimate = z.strictObject({
  verticalFovDeg: z.number().gt(0).lt(180),
  aspect: z.number().positive(),
  pose: Transform,
  status: Confirmation,
  method: z.string().min(1).max(120),
});
export type CameraEstimate = z.infer<typeof CameraEstimate>;

export const FrameRef = z.strictObject({
  assetId: AssetId,
  mimeType: z.string().min(3).max(100),
  byteSize: z.int().positive(),
  width: PixelSize,
  height: PixelSize,
  contentHash: ContentHash,
});
export type FrameRef = z.infer<typeof FrameRef>;

/**
 * "evidence" frames are persisted observations; "preview" frames are
 * transient live frames that may be dropped when stale (backpressure).
 */
export const ObservationMode = z.enum(["evidence", "preview"]);

export const Observation = z.strictObject({
  schemaVersion: SchemaVersion,
  id: ObservationId,
  projectId: ProjectId,
  sourceId: SourceId,
  /** Monotonic per source as sent by the adapter; idempotency key part. */
  sequence: z.int().nonnegative(),
  /** Presentation timestamp within the source, integer microseconds. */
  sourceTimeUs: z.int().nonnegative(),
  frame: FrameRef,
  maskAssetIds: z.array(AssetId),
  objectId: ObjectId.nullable(),
  camera: CameraEstimate.nullable(),
  quality: z.strictObject({
    status: z.enum(["usable", "blurry", "dark", "occluded", "unknown"]),
    score: z.number().min(0).max(1).nullable(),
  }),
  mode: ObservationMode,
  capturedAt: Timestamp.nullable(),
  /** Server arrival time. Distinct from capturedAt and sourceTimeUs. */
  receivedAt: Timestamp,
  /** Arrived after a higher sequence; stored, but never moves "latest" back. */
  outOfOrder: z.boolean(),
});
export type Observation = z.infer<typeof Observation>;

// ---------------------------------------------------------------------------
// CT-005 — capture call lifecycle (Chert FaceTime / phone camera session)
// ---------------------------------------------------------------------------

export const CapabilityState = z.enum(["unknown", "available", "unavailable"]);

export const CaptureSessionState = z.enum([
  "requested", // HTTP allocation accepted — NOT an answered call
  "dialing",
  "bridge_ready", // documented ready event; guidance may begin
  "active", // fresh caller frames are arriving
  "ended",
  "failed",
]);
export type CaptureSessionState = z.infer<typeof CaptureSessionState>;

export const CaptureSession = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: CaptureSessionId,
    projectId: ProjectId,
    kind: z.enum(["chert_facetime", "phone_camera"]),
    state: CaptureSessionState,
    providerCallId: z.string().max(200).nullable(),
    consent: Consent,
    capabilities: z.strictObject({
      callerVideo: CapabilityState,
      agentVideo: CapabilityState,
    }),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    endReason: z.string().max(200).nullable(),
  })
  .superRefine((s, ctx) => {
    const terminal = s.state === "ended" || s.state === "failed";
    if (terminal !== (s.endedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "endedAt is set exactly when state is ended or failed",
      });
    if (s.state === "active" && s.capabilities.callerVideo !== "available")
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "callerVideo"],
        message: "an active session must have callerVideo available",
      });
  });
export type CaptureSession = z.infer<typeof CaptureSession>;
