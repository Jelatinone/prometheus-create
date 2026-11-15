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
  sha256,
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
  pickBundle,
  pickGlb,
  pickMasks,
  type FalQueue,
} from "./fal-queue";
import { normalizeGlb, type NormalizedGlb, type SourceUnits, type SourceUpAxis } from "./glb-normalize";
import { PROVIDER_SPLAT_TO_GLB, SPLAT_MIME, bundleMeshPath, bundleSplatPath, composeTransforms, parseSplatPly, toS1Splat } from "./splat";
import { objectPlacement, parseProviderMetadata, type ScenePlacement } from "./placement";
import { readZip } from "@/lib/editor/project-archive";
import { ensureMeshPreview, findMeshPreview } from "./mesh-preview";
import { maskStats, type MaskStats } from "./mask-stats";

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
  /** HTTP handlers submit once, then advance by one provider status check per request. */
  execution?: "submit" | "poll-once";
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
  /**
   * Inferred Gaussian splat in S1 form (same object-local space as the mesh;
   * PLAN v4 seam S2), or null when the job has none. Never measured depth.
   */
  splatAsset: Asset | null;
  /** Why there is no splat (or what was pruned), for display; null when nothing to report. */
  splatNote: string | null;
  /**
   * Where the provider placed this object in the frame's camera, as a transform
   * for the normalized mesh / S1 splat (see placement.ts); null when unknown.
   * Objects from one frame can be laid out together with levelPlacements().
   */
  placement: ScenePlacement | null;
  /** Why there is no placement; null when nothing to report. */
  placementNote: string | null;
  /**
   * Cached simplified copy of `meshAsset` for interactive preview (CP-010), or
   * null. The full mesh stays the geometry; find it later by
   * `meshPreviewAssetId(projectId, geometry.assetId)`.
   */
  previewMeshAsset: Asset | null;
  /** Why there is no preview, or its size; null when nothing to report. */
  previewNote: string | null;
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
  /**
   * Coverage of each mask (same order as maskAssets; null if undecodable), for
   * choosing the best keyframe and mask (HK-011 CP-022). Scores only on finish.
   */
  maskStats: (MaskStats | null)[];
  providerOutput: unknown;
}

const MASK_TYPE = "image/png";
/** Masks requested per segmentation (fal-ai/sam-3/image max_masks; matches the 2-3 object batch). */
export const SEGMENT_MAX_MASKS = 3;

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
    const unexpected = unexpectedProvider(job);
    if (unexpected) return { ok: false, error: unexpected };
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
    const unexpected = unexpectedProvider(job);
    if (unexpected) return { ok: false, error: unexpected };
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
        if (this.deps.execution === "poll-once") {
          const failure = providerFailure(e, "status (retry polling this job)");
          return err(failure.code, failure.message, failure.details);
        }
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
      if (this.deps.execution === "poll-once") return ok({ job: current, completed: false });
      await this.sleep(this.poll.intervalMs);
    }
  }

  async result(job: ReconstructionJob): Promise<{ ok: true; output: unknown } | { ok: false; error: ContractError }> {
    const unexpected = unexpectedProvider(job);
    if (unexpected) return { ok: false, error: unexpected };
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
    splatAsset: null,
    splatNote: null,
    placement: null,
    placementNote: null,
    previewMeshAsset: null,
    previewNote: null,
    providerOutput,
  };
}

const METADATA_MIME = "application/json";

/** The provider bundle's files (downloaded once per finish), or why they are unavailable. */
interface ProviderBundle {
  files: Map<string, Uint8Array> | null;
  note: string | null;
}

async function loadBundle(deps: ReconstructionDeps, output: unknown): Promise<ProviderBundle> {
  const bundle = pickBundle(output);
  if (!bundle) return { files: null, note: "provider returned no artifacts bundle" };
  let zip: Uint8Array;
  try {
    zip = (await deps.fal.download(bundle.url)).bytes;
  } catch (e) {
    return { files: null, note: `artifacts bundle download failed (${e instanceof Error ? e.message : String(e)})` };
  }
  try {
    return { files: await readZip(zip), note: null };
  } catch (e) {
    return { files: null, note: `artifacts bundle is unreadable (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * Keep the provider's per-object pose (output.metadata) as a provider_raw JSON
 * asset and derive this object's scene placement from it. Never fails the job.
 */
async function persistPlacement(
  deps: ReconstructionDeps,
  projectId: string,
  output: unknown,
  normalized: NormalizedGlb,
  objectIndex = 0,
): Promise<{ asset: Asset | null; placement: ScenePlacement | null; note: string | null }> {
  const metadata = (output as { metadata?: unknown } | null)?.metadata;
  if (metadata === undefined || metadata === null) return { asset: null, placement: null, note: "provider returned no object pose; no placement" };
  const stored = await storeProjectAsset(assetDeps(deps), projectId, new TextEncoder().encode(JSON.stringify(metadata)), {
    kind: "provider_raw",
    mimeType: METADATA_MIME,
    origin: "provider",
  });
  const placed = placementFrom(metadata, normalized, objectIndex);
  return {
    asset: stored.ok ? stored.value : null,
    placement: placed.placement,
    note: placed.note ?? (stored.ok ? null : `provider pose could not be stored (${stored.error.message})`),
  };
}

function placementFrom(metadata: unknown, normalized: NormalizedGlb, objectIndex: number): { placement: ScenePlacement | null; note: string | null } {
  const poses = parseProviderMetadata(metadata);
  if (!poses.ok) return { placement: null, note: `${poses.error.message}; no placement` };
  const pose = poses.value.find((p) => p.objectIndex === objectIndex) ?? (poses.value.length === 1 ? poses.value[0] : undefined);
  if (!pose) return { placement: null, note: `provider pose has no object ${objectIndex}; no placement` };
  return { placement: objectPlacement(pose, normalized.rootTransform), note: null };
}

/**
 * Store object `objectIndex`'s provider splat as an S1 asset aligned with the
 * normalized mesh. Never fails the job: any problem yields `asset: null` and a
 * note, and the mesh-only result stands.
 */
async function persistSplat(
  deps: ReconstructionDeps,
  projectId: string,
  bundle: ProviderBundle,
  normalized: NormalizedGlb,
  objectIndex = 0,
): Promise<{ asset: Asset | null; note: string | null }> {
  const none = (note: string) => ({ asset: null, note });
  if (!bundle.files) return none(`${bundle.note}; mesh only`);
  const entry = bundle.files.get(bundleSplatPath(objectIndex));
  if (!entry) return none(`splat bundle has no ${bundleSplatPath(objectIndex)}; mesh only`);
  const ply = parseSplatPly(entry);
  if (!ply.ok) return none(`${ply.error.message}; mesh only`);
  const root = normalized.rootTransform;
  const s1 = toS1Splat(ply.value, composeTransforms(root, { translation: [0, 0, 0], rotation: PROVIDER_SPLAT_TO_GLB, scale: 1 }));
  if (!s1.ok) return none(`${s1.error.message}; mesh only`);
  const stored = await storeProjectAsset(assetDeps(deps), projectId, s1.value.bytes, { kind: "splat", mimeType: SPLAT_MIME, origin: "provider" });
  if (!stored.ok) return none(`splat could not be stored (${stored.error.message}); mesh only`);
  const { droppedForSize, droppedInvalid, count } = s1.value;
  const notes = [
    droppedForSize ? `${droppedForSize} faintest of ${count + droppedForSize} Gaussians dropped to fit storage` : "",
    droppedInvalid ? `${droppedInvalid} invalid Gaussians dropped` : "",
  ].filter(Boolean);
  return { asset: stored.value, note: notes.length ? notes.join("; ") : null };
}

/** Check each mask is PNG on the observation's exact pixel grid (platform upload rule). */
async function checkMasks(deps: ReconstructionDeps, req: ReconstructionRequest): Promise<Result<string[]>> {
  const hashes: string[] = [];
  for (const maskId of req.maskAssetIds) {
    const loaded = await loadProjectAsset(assetDeps(deps), req.projectId, maskId);
    if (!loaded.ok) return loaded;
    const probe = probeImage(loaded.value.bytes);
    if (!probe.ok) return probe;
    if (loaded.value.asset.kind !== "mask" || loaded.value.asset.mimeType !== MASK_TYPE || probe.value.mimeType !== MASK_TYPE)
      return err("UNSUPPORTED_MEDIA", `mask ${maskId} must be a PNG mask asset`);
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
  // One bundle download serves the mesh, the splat and the pose. The bundle's
  // object mesh is byte-identical to model_glb for single-object outputs
  // (observed on two jobs); model_glb stays the fallback.
  const bundle = await loadBundle(deps, output);
  let raw: Uint8Array | null = null;
  let normalized: Result<NormalizedGlb> | null = null;
  const bundleMesh = bundle.files?.get(bundleMeshPath(0));
  if (bundleMesh) {
    const attempt = normalizeGlb(bundleMesh, deps.convention ?? UNVERIFIED_CONVENTION);
    if (attempt.ok) [raw, normalized] = [bundleMesh, attempt];
  }
  if (!raw) {
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
    try {
      raw = (await deps.fal.download(glbFile.url)).bytes;
    } catch (e) {
      const failed = await driver.fail(job, providerFailure(e, "download GLB"));
      return failed.ok ? ok(emptyOutcome(failed.value, output)) : failed;
    }
    normalized = normalizeGlb(raw, deps.convention ?? UNVERIFIED_CONVENTION);
  }
  if (!normalized || !normalized.ok) {
    const message = normalized && !normalized.ok ? normalized.error.message : "GLB could not be normalized";
    const failed = await driver.fail(job, contractError("INVALID_GEOMETRY", message, { providerRequestId: job.providerRequestId }));
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
  const splat = await persistSplat(deps, job.projectId, bundle, normalized.value);
  const placed = await persistPlacement(deps, job.projectId, output, normalized.value);
  // rawAssetIds[0] is always the provider GLB; [1], when present, the provider pose JSON.
  const rawAssetIds = placed.asset ? [rawAsset.value.id, placed.asset.id] : [rawAsset.value.id];

  const succeeded = await driver.move(job, "succeeded", {
    output: { meshAssetId: meshAsset.value.id, splatAssetId: splat.asset?.id ?? null, maskAssetIds: [], rawAssetIds },
  });
  // A job canceled meanwhile keeps its assets but must not yield geometry.
  let settled: ReconstructionJob;
  if (succeeded.ok) settled = succeeded.value;
  else {
    const reread = await deps.jobs.getJob(deps.actor, job.projectId, job.id);
    if (!reread.ok) return reread;
    settled = reread.value;
  }
  // After success is recorded, so a slow simplification never delays or fails
  // the job; a finish retried after a timeout finds the stored preview.
  const preview =
    settled.state === "succeeded"
      ? await ensureMeshPreview(ad, job.projectId, meshAsset.value, normalized.value.bytes)
      : { asset: null, note: null };
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
    splatAsset: splat.asset,
    splatNote: splat.note,
    placement: placed.placement,
    placementNote: placed.note,
    previewMeshAsset: preview.asset,
    previewNote: preview.note,
    providerOutput: output,
  });
}

/**
 * Reconstruct one object from a frame and its mask(s) with fal-ai/sam-3/3d-objects.
 * Errors before the job exists (bad input, missing assets) return an error;
 * once the job exists, every provider failure is recorded on the job.
 */
/**
 * The provider endpoints this server pays for and reads from. A stored job can
 * be created through the jobs API with any `providerModel`, so a job naming
 * anything else is refused before a provider call (security review, CP-017).
 */
const PROVIDER_MODELS: readonly string[] = [SAM3D_OBJECTS_MODEL, SAM3_IMAGE_MODEL];

function unexpectedProvider(job: ReconstructionJob): ContractError | null {
  if (job.provider === "fal" && PROVIDER_MODELS.includes(job.providerModel)) return null;
  return { code: "INVALID_TRANSITION", message: `job ${job.id} names an unexpected provider or model; it was not sent`, details: {} };
}

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
  // createJob returns an existing job with the same ID and input hash: make sure it is the job this call describes.
  if (job.kind !== "reconstruct_object" || job.providerModel !== SAM3D_OBJECTS_MODEL)
    return err("INVALID_TRANSITION", `job ${job.id} already exists as a different kind of job`);
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
  if (deps.execution === "submit") return ok(emptyOutcome(job));
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
    let splatAsset: Asset | null = null;
    if (job.output.splatAssetId) {
      const splat = await deps.assets.getAsset(deps.actor, job.projectId, job.output.splatAssetId);
      if (!splat.ok) return splat;
      splatAsset = splat.value;
    }
    let placed: { placement: ScenePlacement | null; note: string | null } = { placement: null, note: "this job has no stored provider pose" };
    const poseId = job.output.rawAssetIds[1];
    if (poseId) {
      const pose = await loadProjectAsset(assetDeps(deps), job.projectId, poseId);
      if (!pose.ok) return pose;
      try {
        placed = placementFrom(JSON.parse(new TextDecoder().decode(pose.value.bytes)), normalized.value, 0);
      } catch {
        placed = { placement: null, note: "stored provider pose is not JSON; no placement" };
      }
    }
    // Lookup only: a resume never simplifies (see previewMesh for that).
    const preview = await findMeshPreview(assetDeps(deps), job.projectId, mesh.value.id);
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
      splatAsset,
      splatNote: splatAsset ? null : "this job has no stored splat",
      placement: placed.placement,
      placementNote: placed.note,
      previewMeshAsset: preview.asset,
      previewNote: preview.note,
      providerOutput: null,
    });
  }
  if (isTerminalJobState(job.state)) return ok({ ...emptyOutcome(job), apply: canApplyJobResult(job, current) });
  return continueReconstruction(deps, driver, job, current);
}

/**
 * Deterministic ID of the job that backfills a splat for `jobId`, so repeated
 * attach requests (and Track B) always find the same backfill job.
 */
export async function splatBackfillJobId(jobId: string): Promise<string> {
  const digest = await sha256(`splat-backfill:${jobId}`);
  return `job_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

/**
 * Give an already-succeeded reconstruction a stored S1 splat WITHOUT a new
 * provider job (PLAN v4 seam S5). A succeeded job is terminal, so its output
 * cannot gain a splatAssetId; instead a backfill job with a derived ID adopts
 * the original's provider request ID (never calling submit) and runs the normal
 * poll/finish path: result fetch and file downloads only. The backfill outcome
 * carries the splat; its mesh asset ID equals the original's (content-addressed),
 * which proves the splat is aligned with that exact mesh.
 */
export async function backfillSplat(
  deps: ReconstructionDeps,
  req: { projectId: string; jobId: string },
): Promise<Result<ReconstructionOutcome>> {
  const found = await deps.jobs.getJob(deps.actor, req.projectId, req.jobId);
  if (!found.ok) return found;
  const original = found.value;
  if (original.kind !== "reconstruct_object") return err("INVALID_SCHEMA", `job ${original.id} is not a reconstruction`);
  if (original.state !== "succeeded" || !original.output?.meshAssetId)
    return err("INVALID_TRANSITION", `job ${original.id} is ${original.state}; only a succeeded reconstruction can gain a splat`);
  if (original.output.splatAssetId) return resumeReconstruction(deps, { projectId: req.projectId, jobId: original.id });
  if (!original.providerRequestId) return err("INVALID_TRANSITION", `job ${original.id} has no provider request to reuse`);

  const id = await splatBackfillJobId(original.id);
  const existing = await deps.jobs.getJob(deps.actor, req.projectId, id);
  if (existing.ok) return resumeReconstruction(deps, { projectId: req.projectId, jobId: id });
  if (existing.error.code !== "NOT_FOUND") return existing;

  const driver = new JobDriver(deps);
  const created = await driver.create({
    schemaVersion: 1,
    id,
    projectId: req.projectId,
    kind: "reconstruct_object",
    provider: original.provider,
    providerModel: original.providerModel,
    inputHash: original.inputHash,
    input: original.input,
  });
  if (!created.ok) return created;
  // Adopt the paid request: recorded as submitted, but submit() is never called.
  const adopted = await driver.move(created.value, "submitted", { providerRequestId: original.providerRequestId });
  if (!adopted.ok) return adopted;
  if (deps.execution === "submit") return ok(emptyOutcome(adopted.value));
  return continueReconstruction(deps, driver, adopted.value, original.input.baseGeometryRevision);
}

/**
 * Give a succeeded reconstruction a cached simplified preview of its mesh
 * (CP-010), then return its outcome. No provider call: the stored mesh is
 * simplified locally. Idempotent; a mesh within the budget gets none.
 */
export async function previewMesh(
  deps: ReconstructionDeps,
  req: { projectId: string; jobId: string; currentGeometryRevision?: number },
): Promise<Result<ReconstructionOutcome>> {
  const found = await deps.jobs.getJob(deps.actor, req.projectId, req.jobId);
  if (!found.ok) return found;
  const job = found.value;
  if (job.kind !== "reconstruct_object") return err("INVALID_SCHEMA", `job ${job.id} is not a reconstruction`);
  if (job.state !== "succeeded" || !job.output?.meshAssetId)
    return err("INVALID_TRANSITION", `job ${job.id} is ${job.state}; only a succeeded reconstruction has a mesh to preview`);
  const mesh = await deps.assets.getAsset(deps.actor, job.projectId, job.output.meshAssetId);
  if (!mesh.ok) return mesh;
  await ensureMeshPreview(assetDeps(deps), job.projectId, mesh.value);
  return resumeReconstruction(deps, req);
}

/**
 * Obtain object masks for a frame with fal-ai/sam-3/image (text prompt). Each
 * mask must match the frame's pixel grid; masks are stored as owned assets.
 */
export async function runSegmentation(deps: ReconstructionDeps, req: SegmentationRequest): Promise<Result<SegmentationOutcome>> {
  const driver = new JobDriver(deps);
  const inputHash = await hashJson({ model: SAM3_IMAGE_MODEL, image: req.observation.frame.contentHash, prompt: req.prompt, maxMasks: SEGMENT_MAX_MASKS });
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
  if (job.kind !== "segment" || job.providerModel !== SAM3_IMAGE_MODEL)
    return err("INVALID_TRANSITION", `job ${job.id} already exists as a different kind of job`);
  const fail = async (error: ContractError, providerOutput: unknown = null): Promise<Result<SegmentationOutcome>> => {
    const failed = await driver.fail(job, error);
    return failed.ok ? ok({ job: failed.value, maskAssets: [], maskStats: [], providerOutput }) : failed;
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
    // Every instance matching the prompt (up to 3), so one frame can yield 2-3 objects.
    return_multiple_masks: true,
    max_masks: SEGMENT_MAX_MASKS,
    include_scores: true,
  });
  if (!submitted.ok) return submitted;
  job = submitted.value;
  if (job.state === "failed") return ok({ job, maskAssets: [], maskStats: [], providerOutput: null });
  if (deps.execution === "submit") return ok({ job, maskAssets: [], maskStats: [], providerOutput: null });
  return resumeSegmentation(deps, { projectId: req.projectId, jobId: job.id, observation: req.observation });
}

/** Resume the existing segmentation request; never submits or pays again. */
export async function resumeSegmentation(
  deps: ReconstructionDeps,
  req: { projectId: string; jobId: string; observation: Observation },
): Promise<Result<SegmentationOutcome>> {
  const found = await deps.jobs.getJob(deps.actor, req.projectId, req.jobId);
  if (!found.ok) return found;
  let job = found.value;
  if (job.kind !== "segment" || job.input.observationId !== req.observation.id)
    return err("INVALID_SCHEMA", "segmentation job does not match this observation");
  if (job.state === "succeeded") {
    const maskAssets: Asset[] = [];
    const stats: (MaskStats | null)[] = [];
    for (const id of job.output?.maskAssetIds ?? []) {
      const loaded = await loadProjectAsset(assetDeps(deps), req.projectId, id);
      if (!loaded.ok) return loaded;
      maskAssets.push(loaded.value.asset);
      stats.push(await maskStats(id, loaded.value.bytes));
    }
    return ok({ job, maskAssets, maskStats: stats, providerOutput: null });
  }
  if (isTerminalJobState(job.state)) return ok({ job, maskAssets: [], maskStats: [], providerOutput: null });
  if (!job.providerRequestId) return err("INVALID_TRANSITION", "submission was not confirmed; reconcile before starting another job");
  const driver = new JobDriver(deps);
  const fail = async (error: ContractError, providerOutput: unknown = null): Promise<Result<SegmentationOutcome>> => {
    const failed = await driver.fail(job, error);
    return failed.ok ? ok({ job: failed.value, maskAssets: [], maskStats: [], providerOutput }) : failed;
  };
  const waited = await driver.waitForCompletion(job);
  if (!waited.ok) return waited;
  job = waited.value.job;
  if (!waited.value.completed) return ok({ job, maskAssets: [], maskStats: [], providerOutput: null });

  const fetched = await driver.result(job);
  if (!fetched.ok) return fail(fetched.error);
  const files = pickMasks(fetched.output);
  if (files.length === 0) return fail(contractError("INVALID_SCHEMA", "no object mask found; try a clearer frame or object description"), fetched.output);
  const maskAssets: Asset[] = [];
  const stats: (MaskStats | null)[] = [];
  const rawScores = (fetched.output as { scores?: unknown } | null)?.scores;
  const scores = Array.isArray(rawScores) && rawScores.length === files.length ? rawScores : [];
  for (const [index, file] of files.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = (await deps.fal.download(file.url)).bytes;
    } catch (e) {
      return fail(providerFailure(e, "download mask"), fetched.output);
    }
    const probe = probeImage(bytes);
    if (!probe.ok) return fail(probe.error, fetched.output);
    if (probe.value.mimeType !== MASK_TYPE)
      return fail(contractError("UNSUPPORTED_MEDIA", "provider mask must be PNG"), fetched.output);
    const { width, height } = req.observation.frame;
    if (probe.value.width !== width || probe.value.height !== height)
      return fail(
        contractError("INVALID_SCHEMA", `mask is ${probe.value.width}x${probe.value.height}; frame is ${width}x${height} (would not align)`),
        fetched.output,
      );
    const stored = await storeProjectAsset(assetDeps(deps), req.projectId, bytes, {
      kind: "mask",
      mimeType: MASK_TYPE,
      origin: "provider",
    });
    if (!stored.ok) return stored;
    maskAssets.push(stored.value);
    const score = typeof scores[index] === "number" ? (scores[index] as number) : null;
    stats.push(await maskStats(stored.value.id, bytes, score));
  }
  const succeeded = await driver.move(job, "succeeded", {
    output: { meshAssetId: null, splatAssetId: null, maskAssetIds: maskAssets.map((a) => a.id), rawAssetIds: [] },
  });
  if (!succeeded.ok) return succeeded;
  return ok({ job: succeeded.value, maskAssets, maskStats: stats, providerOutput: fetched.output });
}
