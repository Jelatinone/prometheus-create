/**
 * Provider jobs (CT-002) driven through the JobStore port:
 *
 *   queued -> submitted (providerRequestId stored BEFORE the first poll)
 *          -> running -> succeeded | failed
 *
 * - Submit once. A job with a request ID is never submitted again; it is
 *   resumed by polling that ID (reconcile before paying for another job).
 * - Failures (timeout, provider error, missing or invalid GLB) end the job as
 *   `failed` with a ContractError and produce no geometry.
 * - Accepted outputs are copied to owned storage; provider URLs are temporary.
 * - A succeeded result becomes a geometry candidate only when
 *   canApplyJobResult says it is current; a stale completion is kept as assets
 *   but never replaces newer geometry.
 */
import {
  canApplyJobResult,
  err,
  hashJson,
  isTerminalJobState,
  newId,
  ok,
  type Actor,
  type Asset,
  type AssetCatalog,
  type ContractError,
  type ErrorCode,
  type Geometry,
  type JobStore,
  type Observation,
  type ReconstructionJob,
  type Result,
  type Vec3,
} from "@/lib/contracts";
import type { GlbInspection } from "@/lib/assets/glb";
import { loadProjectAsset, storeProjectAsset, type AssetDeps } from "@/lib/capture/assets";
import type { BlobStore } from "@/lib/capture/blob-store";
import { probeImage } from "@/lib/capture/probe";
import {
  FalQueueError,
  SAM3D_OBJECTS_MODEL,
  SAM3_IMAGE_MODEL,
  pickGlb,
  pickMasks,
  type FalQueue,
} from "./fal-queue";
import { normalizeGlb, type SourceUnits, type SourceUpAxis } from "./glb-normalize";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Consecutive status-call failures tolerated before the job fails. */
  maxStatusErrors: number;
}

export const DEFAULT_POLL: PollOptions = { intervalMs: 2_000, timeoutMs: 5 * 60_000, maxStatusErrors: 5 };

/**
 * Units and up axis of the provider's GLB. fal documents neither, so the
 * default is "unknown" (file units kept, no rotation, dimensions estimated)
 * until a real output justifies a claim.
 */
export interface GlbConvention {
  sourceUnits: SourceUnits;
  sourceUpAxis: SourceUpAxis;
}

export const UNVERIFIED_CONVENTION: GlbConvention = { sourceUnits: "unknown", sourceUpAxis: "unknown" };

export type JobProgress =
  | { type: "state"; job: ReconstructionJob }
  | { type: "poll"; status: string; elapsedMs: number; queuePosition?: number };

export interface ReconstructionDeps {
  jobs: JobStore;
  assets: AssetCatalog;
  blobs: BlobStore;
  fal: FalQueue;
  actor: Actor;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  poll?: Partial<PollOptions>;
  convention?: GlbConvention;
  onProgress?: (event: JobProgress) => void;
}

export interface ReconstructionRequest {
  projectId: string;
  /** Anchor frame; masks must match its pixel grid. */
  observation: Observation;
  maskAssetIds: string[];
  targetObjectId: string | null;
  /** Target's geometry revision when the job starts (0 = new object). */
  baseGeometryRevision: number;
  /** Target's revision when the result arrives; defaults to the base revision. */
  currentGeometryRevision?: number;
  seed?: number;
  jobId?: string;
}

export interface ReconstructionOutcome {
  job: ReconstructionJob;
  /** Applicable geometry candidate, or null (failed, canceled, or stale). */
  geometry: Geometry | null;
  apply: { apply: boolean; reason: string };
  meshAsset: Asset | null;
  rawAsset: Asset | null;
  inspection: GlbInspection | null;
  originalInspection: GlbInspection | null;
  recenterOffset: Vec3 | null;
  /** Provider output JSON as returned (URLs are temporary). */
  providerOutput: unknown;
}

export interface SegmentationRequest {
  projectId: string;
  observation: Observation;
  /** Text prompt for fal-ai/sam-3/image, e.g. "chair". */
  prompt: string;
  jobId?: string;
}

export interface SegmentationOutcome {
  job: ReconstructionJob;
  maskAssets: Asset[];
  providerOutput: unknown;
}

const MASK_TYPE = "image/png";

function assetDeps(deps: ReconstructionDeps): AssetDeps {
  return { assets: deps.assets, blobs: deps.blobs, actor: deps.actor, now: deps.now };
}

function contractError(code: ErrorCode, message: string, details?: Record<string, unknown>): ContractError {
  return details ? { code, message, details } : { code, message };
}

function providerFailure(e: unknown, step: string): ContractError {
  if (e instanceof FalQueueError) {
    const code: ErrorCode = e.status === 422 ? "INVALID_SCHEMA" : "PROVIDER_UNAVAILABLE";
    return contractError(code, `${step}: ${e.message}`, e.status ? { httpStatus: e.status } : undefined);
  }
  return contractError("PROVIDER_UNAVAILABLE", `${step}: ${e instanceof Error ? e.message : String(e)}`);
}

class JobDriver {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly poll: PollOptions;

  constructor(private readonly deps: ReconstructionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.poll = { ...DEFAULT_POLL, ...deps.poll };
  }

  private emit(job: ReconstructionJob): ReconstructionJob {
    this.deps.onProgress?.({ type: "state", job });
    return job;
  }

  async create(job: Omit<ReconstructionJob, "history" | "createdAt" | "updatedAt" | "state" | "providerRequestId" | "output" | "error">): Promise<Result<ReconstructionJob>> {
    const at = this.now().toISOString();
    const created = await this.deps.jobs.createJob(this.deps.actor, {
      ...job,
      state: "queued",
      providerRequestId: null,
      history: [{ number: 1, state: "queued", at, providerRequestId: null, error: null }],
      output: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    });
    return created.ok ? ok(this.emit(created.value)) : created;
  }

  async move(
    job: ReconstructionJob,
    to: ReconstructionJob["state"],
    patch: Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">> = {},
  ): Promise<Result<ReconstructionJob>> {
    const next = await this.deps.jobs.transitionJob(this.deps.actor, job.projectId, job.id, to, patch);
    return next.ok ? ok(this.emit(next.value)) : next;
  }

  fail(job: ReconstructionJob, error: ContractError): Promise<Result<ReconstructionJob>> {
    return this.move(job, "failed", { error });
  }

  /** Submit a queued job once and persist its request ID before any polling. */
  async submit(job: ReconstructionJob, input: Record<string, unknown>): Promise<Result<ReconstructionJob>> {
    if (job.providerRequestId)
      return err("INVALID_TRANSITION", `job ${job.id} already has provider request ${job.providerRequestId}; resume it instead`);
    let requestId: string;
    try {
      requestId = (await this.deps.fal.submit(job.providerModel, input)).requestId;
    } catch (e) {
      return this.fail(job, providerFailure(e, "submit"));
    }
    return this.move(job, "submitted", { providerRequestId: requestId });
  }

  /** Poll a submitted/running job to COMPLETED; the job is failed on timeout or repeated errors. */
  async waitForCompletion(job: ReconstructionJob): Promise<Result<{ job: ReconstructionJob; completed: boolean }>> {
    const requestId = job.providerRequestId;
    if (!requestId) return err("INVALID_TRANSITION", `job ${job.id} has no provider request id to poll`);
    const started = this.now().getTime();
    let current = job;
    let statusErrors = 0;
    for (;;) {
      const elapsedMs = this.now().getTime() - started;
      if (elapsedMs > this.poll.timeoutMs) {
        const failed = await this.fail(
          current,
          contractError("PROVIDER_UNAVAILABLE", `timed out after ${Math.round(elapsedMs / 1000)}s waiting for ${current.providerModel}`, {
            providerRequestId: requestId,
            reconcile: "the provider request may still finish; poll this request id before submitting a new job",
          }),
        );
        return failed.ok ? ok({ job: failed.value, completed: false }) : failed;
      }
      let status;
      try {
        status = await this.deps.fal.status(current.providerModel, requestId);
        statusErrors = 0;
      } catch (e) {
        statusErrors++;
        if (statusErrors >= this.poll.maxStatusErrors) {
          const failed = await this.fail(current, providerFailure(e, `status (${statusErrors} consecutive failures)`));
          return failed.ok ? ok({ job: failed.value, completed: false }) : failed;
        }
        await this.sleep(this.poll.intervalMs);
        continue;
      }
      this.deps.onProgress?.({ type: "poll", status: status.status, elapsedMs, queuePosition: status.queuePosition });
      if (status.status === "IN_PROGRESS" && current.state === "submitted") {
        const running = await this.move(current, "running");
        if (!running.ok) return running;
        current = running.value;
      }
      if (status.status === "COMPLETED") {
        if (status.error) {
          const failed = await this.fail(current, contractError("PROVIDER_UNAVAILABLE", `provider reported: ${status.error}`, { providerRequestId: requestId }));
          return failed.ok ? ok({ job: failed.value, completed: false }) : failed;
        }
        return ok({ job: current, completed: true });
      }
      await this.sleep(this.poll.intervalMs);
    }
  }

  async result(job: ReconstructionJob): Promise<{ ok: true; output: unknown } | { ok: false; error: ContractError }> {
    try {
      return { ok: true, output: await this.deps.fal.result(job.providerModel, job.providerRequestId!) };
    } catch (e) {
      return { ok: false, error: providerFailure(e, "result") };
    }
  }
}

async function uploadAsset(deps: ReconstructionDeps, projectId: string, assetId: string, label: string): Promise<Result<string>> {
  const loaded = await loadProjectAsset(assetDeps(deps), projectId, assetId);
  if (!loaded.ok) return loaded;
  try {
    const ext = loaded.value.asset.mimeType.split("/")[1] ?? "bin";
    return ok(await deps.fal.upload(loaded.value.bytes, loaded.value.asset.mimeType, `${label}.${ext}`));
  } catch (e) {
    const failure = providerFailure(e, `upload ${label}`);
    return err(failure.code, failure.message, failure.details);
  }
}

function emptyOutcome(job: ReconstructionJob, providerOutput: unknown = null): ReconstructionOutcome {
  return {
    job,
    geometry: null,
    apply: canApplyJobResult(job, job.input.baseGeometryRevision),
    meshAsset: null,
    rawAsset: null,
    inspection: null,
    originalInspection: null,
    recenterOffset: null,
    providerOutput,
  };
}

/** Check each mask is a still on the observation's exact pixel grid. */
async function checkMasks(deps: ReconstructionDeps, req: ReconstructionRequest): Promise<Result<string[]>> {
  const hashes: string[] = [];
  for (const maskId of req.maskAssetIds) {
    const loaded = await loadProjectAsset(assetDeps(deps), req.projectId, maskId);
    if (!loaded.ok) return loaded;
    const probe = probeImage(loaded.value.bytes);
    if (!probe.ok) return probe;
    const { width, height } = req.observation.frame;
    if (probe.value.width !== width || probe.value.height !== height)
      return err("INVALID_SCHEMA", `mask ${maskId} is ${probe.value.width}x${probe.value.height}; frame is ${width}x${height}`);
    hashes.push(loaded.value.asset.contentHash);
  }
  return ok(hashes);
}

/** Download, validate, normalize and store a completed reconstruction. */
async function finishReconstruction(
  deps: ReconstructionDeps,
  driver: JobDriver,
  job: ReconstructionJob,
  currentGeometryRevision: number,
): Promise<Result<ReconstructionOutcome>> {
  const fetched = await driver.result(job);
  if (!fetched.ok) {
    const failed = await driver.fail(job, fetched.error);
    return failed.ok ? ok(emptyOutcome(failed.value)) : failed;
  }
  const output = fetched.output;
  const glbFile = pickGlb(output);
  if (!glbFile) {
    const failed = await driver.fail(
      job,
      contractError("INVALID_GEOMETRY", "provider response has no GLB (model_glb missing); refusing to create an object", {
        providerRequestId: job.providerRequestId,
      }),
    );
    return failed.ok ? ok(emptyOutcome(failed.value, output)) : failed;
  }
  let raw: Uint8Array;
  try {
    raw = (await deps.fal.download(glbFile.url)).bytes;
  } catch (e) {
    const failed = await driver.fail(job, providerFailure(e, "download GLB"));
    return failed.ok ? ok(emptyOutcome(failed.value, output)) : failed;
  }
  const normalized = normalizeGlb(raw, deps.convention ?? UNVERIFIED_CONVENTION);
  if (!normalized.ok) {
    const failed = await driver.fail(job, contractError("INVALID_GEOMETRY", normalized.error.message, { providerRequestId: job.providerRequestId }));
    return failed.ok ? ok(emptyOutcome(failed.value, output)) : failed;
  }

  // Copy provider output to owned storage before recording success.
  const ad = assetDeps(deps);
  const rawAsset = await storeProjectAsset(ad, job.projectId, raw, { kind: "provider_raw", mimeType: "model/gltf-binary", origin: "provider" });
  if (!rawAsset.ok) return rawAsset;
  const meshAsset = await storeProjectAsset(ad, job.projectId, normalized.value.bytes, {
    kind: "mesh",
    mimeType: "model/gltf-binary",
    origin: "provider",
  });
  if (!meshAsset.ok) return meshAsset;

  const succeeded = await driver.move(job, "succeeded", {
    output: { meshAssetId: meshAsset.value.id, splatAssetId: null, maskAssetIds: [], rawAssetIds: [rawAsset.value.id] },
  });
  // A job canceled meanwhile keeps its assets but must not yield geometry.
  let settled: ReconstructionJob;
  if (succeeded.ok) settled = succeeded.value;
  else {
    const reread = await deps.jobs.getJob(deps.actor, job.projectId, job.id);
    if (!reread.ok) return reread;
    settled = reread.value;
  }
  const apply = canApplyJobResult(settled, currentGeometryRevision);
  const geometry: Geometry | null = apply.apply
    ? {
        assetId: meshAsset.value.id,
        geometryRevision: settled.input.baseGeometryRevision + 1,
        originalAssetId: rawAsset.value.id,
        normalization: normalized.value.normalization,
        localBounds: normalized.value.localBounds,
      }
    : null;
  return ok({
    job: settled,
    geometry,
    apply,
    meshAsset: meshAsset.value,
    rawAsset: rawAsset.value,
    inspection: normalized.value.inspection,
    originalInspection: normalized.value.original,
    recenterOffset: normalized.value.recenterOffset,
    providerOutput: output,
  });
}

/**
 * Reconstruct one object from a frame and its mask(s) with fal-ai/sam-3/3d-objects.
 * Errors before the job exists (bad input, missing assets) return an error;
 * once the job exists, every provider failure is recorded on the job.
 */
export async function runReconstruction(deps: ReconstructionDeps, req: ReconstructionRequest): Promise<Result<ReconstructionOutcome>> {
  if (req.maskAssetIds.length === 0) return err("INVALID_SCHEMA", "choose a mask: reconstruction needs at least one mask asset");
  const maskHashes = await checkMasks(deps, req);
  if (!maskHashes.ok) return maskHashes;
  const driver = new JobDriver(deps);
  const inputHash = await hashJson({
    model: SAM3D_OBJECTS_MODEL,
    image: req.observation.frame.contentHash,
    masks: maskHashes.value,
    seed: req.seed ?? null,
  });
  const created = await driver.create({
    schemaVersion: 1,
    id: req.jobId ?? newId("job"),
    projectId: req.projectId,
    kind: "reconstruct_object",
    provider: "fal",
    providerModel: SAM3D_OBJECTS_MODEL,
    inputHash,
    input: {
      observationId: req.observation.id,
      maskAssetIds: req.maskAssetIds,
      targetObjectId: req.targetObjectId,
      baseGeometryRevision: req.baseGeometryRevision,
    },
  });
  if (!created.ok) return created;
  let job = created.value;
  if (isTerminalJobState(job.state) || job.providerRequestId)
    return resumeReconstruction(deps, { projectId: req.projectId, jobId: job.id, currentGeometryRevision: req.currentGeometryRevision });

  const image = await uploadAsset(deps, req.projectId, req.observation.frame.assetId, "frame");
  if (!image.ok) {
    const failed = await driver.fail(job, image.error);
    return failed.ok ? ok(emptyOutcome(failed.value)) : failed;
  }
  const maskUrls: string[] = [];
  for (const [i, maskId] of req.maskAssetIds.entries()) {
    const url = await uploadAsset(deps, req.projectId, maskId, `mask-${i}`);
    if (!url.ok) {
      const failed = await driver.fail(job, url.error);
      return failed.ok ? ok(emptyOutcome(failed.value)) : failed;
    }
    maskUrls.push(url.value);
  }
  const input: Record<string, unknown> = { image_url: image.value, mask_urls: maskUrls };
  if (req.seed !== undefined) input.seed = req.seed;

  const submitted = await driver.submit(job, input);
  if (!submitted.ok) return submitted;
  job = submitted.value;
  if (job.state === "failed") return ok(emptyOutcome(job));
  return continueReconstruction(deps, driver, job, req.currentGeometryRevision ?? req.baseGeometryRevision);
}

async function continueReconstruction(
  deps: ReconstructionDeps,
  driver: JobDriver,
  job: ReconstructionJob,
  currentGeometryRevision: number,
): Promise<Result<ReconstructionOutcome>> {
  const waited = await driver.waitForCompletion(job);
  if (!waited.ok) return waited;
  if (!waited.value.completed) return ok(emptyOutcome(waited.value.job));
  return finishReconstruction(deps, driver, waited.value.job, currentGeometryRevision);
}

/**
 * Continue a job by its stored provider request ID (after a restart or a lost
 * response). Never submits: a queued job without a request ID is an error so a
 * possibly-lost paid submission is reconciled by a person, not duplicated.
 */
export async function resumeReconstruction(
  deps: ReconstructionDeps,
  req: { projectId: string; jobId: string; currentGeometryRevision?: number },
): Promise<Result<ReconstructionOutcome>> {
  const found = await deps.jobs.getJob(deps.actor, req.projectId, req.jobId);
  if (!found.ok) return found;
  const job = found.value;
  const current = req.currentGeometryRevision ?? job.input.baseGeometryRevision;
  const driver = new JobDriver(deps);
  if (job.state === "queued")
    return err("INVALID_TRANSITION", `job ${job.id} is queued with no provider request id; it was never confirmed submitted`);
  if (job.state === "succeeded" && job.output?.meshAssetId && job.output.rawAssetIds[0]) {
    // Rebuild the candidate from owned copies (normalization is deterministic).
    const raw = await loadProjectAsset(assetDeps(deps), job.projectId, job.output.rawAssetIds[0]);
    if (!raw.ok) return raw;
    const normalized = normalizeGlb(raw.value.bytes, deps.convention ?? UNVERIFIED_CONVENTION);
    if (!normalized.ok) return normalized;
    const mesh = await deps.assets.getAsset(deps.actor, job.projectId, job.output.meshAssetId);
    if (!mesh.ok) return mesh;
    const apply = canApplyJobResult(job, current);
    return ok({
      job,
      apply,
      geometry: apply.apply
        ? {
            assetId: mesh.value.id,
            geometryRevision: job.input.baseGeometryRevision + 1,
            originalAssetId: raw.value.asset.id,
            normalization: normalized.value.normalization,
            localBounds: normalized.value.localBounds,
          }
        : null,
      meshAsset: mesh.value,
      rawAsset: raw.value.asset,
      inspection: normalized.value.inspection,
      originalInspection: normalized.value.original,
      recenterOffset: normalized.value.recenterOffset,
      providerOutput: null,
    });
  }
  if (isTerminalJobState(job.state)) return ok({ ...emptyOutcome(job), apply: canApplyJobResult(job, current) });
  return continueReconstruction(deps, driver, job, current);
}

/**
 * Obtain object masks for a frame with fal-ai/sam-3/image (text prompt). Each
 * mask must match the frame's pixel grid; masks are stored as owned assets.
 */
export async function runSegmentation(deps: ReconstructionDeps, req: SegmentationRequest): Promise<Result<SegmentationOutcome>> {
  const driver = new JobDriver(deps);
  const inputHash = await hashJson({ model: SAM3_IMAGE_MODEL, image: req.observation.frame.contentHash, prompt: req.prompt });
  const created = await driver.create({
    schemaVersion: 1,
    id: req.jobId ?? newId("job"),
    projectId: req.projectId,
    kind: "segment",
    provider: "fal",
    providerModel: SAM3_IMAGE_MODEL,
    inputHash,
    input: { observationId: req.observation.id, maskAssetIds: [], targetObjectId: null, baseGeometryRevision: 0 },
  });
  if (!created.ok) return created;
  let job = created.value;
  const fail = async (error: ContractError, providerOutput: unknown = null): Promise<Result<SegmentationOutcome>> => {
    const failed = await driver.fail(job, error);
    return failed.ok ? ok({ job: failed.value, maskAssets: [], providerOutput }) : failed;
  };
  if (isTerminalJobState(job.state) || job.providerRequestId)
    return err("INVALID_TRANSITION", `segmentation job ${job.id} already exists in state ${job.state}`);

  const image = await uploadAsset(deps, req.projectId, req.observation.frame.assetId, "frame");
  if (!image.ok) return fail(image.error);
  const submitted = await driver.submit(job, {
    image_url: image.value,
    prompt: req.prompt,
    apply_mask: false,
    output_format: "png",
    return_multiple_masks: false,
  });
  if (!submitted.ok) return submitted;
  job = submitted.value;
  if (job.state === "failed") return ok({ job, maskAssets: [], providerOutput: null });
  const waited = await driver.waitForCompletion(job);
  if (!waited.ok) return waited;
  job = waited.value.job;
  if (!waited.value.completed) return ok({ job, maskAssets: [], providerOutput: null });

  const fetched = await driver.result(job);
  if (!fetched.ok) return fail(fetched.error);
  const files = pickMasks(fetched.output);
  if (files.length === 0) return fail(contractError("INVALID_SCHEMA", `no mask found for prompt "${req.prompt}"`), fetched.output);
  const maskAssets: Asset[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = (await deps.fal.download(file.url)).bytes;
    } catch (e) {
      return fail(providerFailure(e, "download mask"), fetched.output);
    }
    const probe = probeImage(bytes);
    if (!probe.ok) return fail(probe.error, fetched.output);
    const { width, height } = req.observation.frame;
    if (probe.value.width !== width || probe.value.height !== height)
      return fail(
        contractError("INVALID_SCHEMA", `mask is ${probe.value.width}x${probe.value.height}; frame is ${width}x${height} (would not align)`),
        fetched.output,
      );
    const stored = await storeProjectAsset(assetDeps(deps), req.projectId, bytes, {
      kind: "mask",
      mimeType: probe.value.mimeType === "image/png" ? MASK_TYPE : probe.value.mimeType,
      origin: "provider",
    });
    if (!stored.ok) return stored;
    maskAssets.push(stored.value);
  }
  const succeeded = await driver.move(job, "succeeded", {
    output: { meshAssetId: null, splatAssetId: null, maskAssetIds: maskAssets.map((a) => a.id), rawAssetIds: [] },
  });
  if (!succeeded.ok) return succeeded;
  return ok({ job: succeeded.value, maskAssets, providerOutput: fetched.output });
}
