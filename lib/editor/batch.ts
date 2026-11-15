/**
 * Generate, S4 phase 1 (PLAN v4) with a dynamic object count.
 *
 *   find:     one description → one segmentation job → EVERY instance the provider
 *             finds (all masks), each listed as a found object the user may remove
 *   generate: one reconstruction job per remaining found object (single-mask API)
 *
 * Nothing fixes how many objects a frame yields: it is however many instances the
 * descriptions find, minus the ones removed. Every job ID is chosen and persisted
 * before its request.
 *
 * Retry never pays twice. The route resumes any existing job ID instead of
 * submitting it again, so:
 *   - network/5xx/timeout → the SAME job ID is retried automatically with backoff
 *     (a slow finish converges; see lib/reconstruction/README.md)
 *   - job busy in another request (route lock) → wait and poll
 *   - job failed before the provider accepted it → retry with a FRESH job ID (free)
 *   - job failed after the provider accepted it → a fresh job ID only with explicit
 *     confirmation (a new charge); the failed job itself is never sent again
 */
import { newId, type Result } from "@/lib/contracts/common";
import type { ReconstructionOutcome, SegmentationOutcome } from "@/lib/reconstruction/runner";

/** Safety ceiling per Generate press (budget), not a target: the count comes from what was found. */
export const MAX_GENERATE = 12;
/** Automatic same-ID retries for network/5xx/timeouts before asking the person. */
export const AUTO_RETRIES = 4;

export interface BatchFrame {
  id: string;
  sourceId: string;
  projectId: string;
}

/** One provider job and what the client knows about it. */
export interface JobTrack {
  jobId: string;
  stage: "pending" | "running" | "done" | "failed";
  jobState?: string;
  providerRequestId?: string | null;
  error?: string;
  errorKind?: "transport" | "job";
  /** Jobs abandoned on retry (kept for the record; never sent again). */
  abandonedJobIds?: string[];
}

export interface Find {
  key: string;
  prompt: string;
  job: JobTrack;
}

export interface FoundObject {
  key: string;
  findKey: string;
  label: string;
  maskAssetId: string;
  removed: boolean;
  /** Present once Generate was pressed for this object. */
  mesh?: JobTrack;
}

export interface Batch {
  id: string;
  frame: BatchFrame;
  takeId: string;
  finds: Find[];
  objects: FoundObject[];
}

export interface Command {
  projectId: string;
  sourceId: string;
  observationId: string;
  jobId: string;
  /** attach_splat: backfill the stored splat of a succeeded reconstruction (never submits). */
  action: "segment" | "reconstruct" | "attach_splat" | "detect";
  prompt?: string;
  maskAssetIds?: string[];
}

export type Outcome = ReconstructionOutcome | SegmentationOutcome;
export type Send = (command: Command) => Promise<Result<Outcome>>;

const track = (): JobTrack => ({ jobId: newId("job"), stage: "pending" });

export function startBatch(frame: BatchFrame, takeId: string): Batch {
  return { id: newId("job").replace("job_", "batch_"), frame, takeId, finds: [], objects: [] };
}

/** Adds a description to look for; returns the batch unchanged for blank or repeated descriptions. */
export function addFind(batch: Batch, prompt: string): Batch {
  const p = prompt.trim().slice(0, 200);
  if (!p || batch.finds.some((f) => f.prompt.toLowerCase() === p.toLowerCase())) return batch;
  return { ...batch, finds: [...batch.finds, { key: `f${batch.finds.length}_${Date.now().toString(36)}`, prompt: p, job: track() }] };
}

/** Found objects from a finished find: one per mask, labelled "chair", or "chair 1", "chair 2", … */
export function objectsFromFind(batch: Batch, find: Find, maskAssetIds: string[]): Batch {
  const known = new Set(batch.objects.map((o) => o.maskAssetId));
  const fresh = maskAssetIds.filter((m) => !known.has(m));
  const many = maskAssetIds.length > 1;
  const objects = fresh.map((maskAssetId) => ({
    key: `o_${maskAssetId.slice(4, 16)}`,
    findKey: find.key,
    label: many ? `${find.prompt} ${maskAssetIds.indexOf(maskAssetId) + 1}` : find.prompt,
    maskAssetId,
    removed: false,
  }));
  return { ...batch, objects: [...batch.objects, ...objects] };
}

export function setRemoved(batch: Batch, key: string, removed: boolean): Batch {
  return { ...batch, objects: batch.objects.map((o) => (o.key === key && !o.mesh ? { ...o, removed } : o)) };
}

/** Objects that Generate would start now: found, kept, not yet generating. */
export function toGenerate(batch: Batch): FoundObject[] {
  return batch.objects.filter((o) => !o.removed && !o.mesh).slice(0, MAX_GENERATE);
}

/** Gives each object to generate its durable mesh job ID (persist the result before sending). */
export function startGenerate(batch: Batch): Batch {
  const start = new Set(toGenerate(batch).map((o) => o.key));
  return { ...batch, objects: batch.objects.map((o) => (start.has(o.key) ? { ...o, mesh: track() } : o)) };
}

export function findCommand(batch: Batch, find: Find): Command {
  return { projectId: batch.frame.projectId, sourceId: batch.frame.sourceId, observationId: batch.frame.id, jobId: find.job.jobId, action: "segment", prompt: find.prompt };
}

export function meshCommand(batch: Batch, object: FoundObject): Command {
  return { projectId: batch.frame.projectId, sourceId: batch.frame.sourceId, observationId: batch.frame.id, jobId: object.mesh!.jobId, action: "reconstruct", maskAssetIds: [object.maskAssetId] };
}

const LOCKED = /processing in another request/i;
const TRANSIENT_CODES = new Set(["PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "RESOURCE_LIMIT"]);

/** One request for one job; returns the updated track and the outcome once it succeeds. */
export async function stepJob(send: Send, command: Command, job: JobTrack): Promise<{ job: JobTrack; outcome?: Outcome; retryable?: boolean }> {
  let response: Result<Outcome>;
  try {
    response = await send(command);
  } catch (e) {
    response = { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: e instanceof Error ? e.message : String(e) } };
  }
  if (!response.ok) {
    if (response.error.code === "PROVIDER_UNAVAILABLE" && LOCKED.test(response.error.message)) return { job: { ...job, stage: "running", jobState: job.jobState ?? "busy" } };
    const message = `${response.error.code}: ${response.error.message}`;
    return { job: { ...job, stage: "failed", errorKind: "transport", error: message }, retryable: TRANSIENT_CODES.has(response.error.code) };
  }
  const j = response.value.job;
  const seen: JobTrack = { ...job, stage: "running", jobState: j.state, providerRequestId: j.providerRequestId ?? null, error: undefined, errorKind: undefined };
  if (j.state === "failed" || j.state === "canceled") return { job: { ...seen, stage: "failed", errorKind: "job", error: j.error?.message ?? `job ${j.state}` } };
  if (j.state === "succeeded") return { job: { ...seen, stage: "done" }, outcome: response.value };
  return { job: seen };
}

export interface RunOptions {
  onUpdate(job: JobTrack, outcome?: Outcome): void;
  sleep?: (ms: number) => Promise<void>;
  alive?: () => boolean;
  pollMs?: number;
}

/** Drives one job until it is done or failed, retrying transient transport errors on the same ID. */
export async function runJob(send: Send, command: Command, job: JobTrack, opts: RunOptions): Promise<{ job: JobTrack; outcome?: Outcome }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current: JobTrack = { ...job, stage: "running" };
  let transient = 0;
  while (opts.alive?.() ?? true) {
    const step = await stepJob(send, command, current);
    current = step.job;
    if (current.stage === "failed" && current.errorKind === "transport" && step.retryable && transient < AUTO_RETRIES) {
      transient++;
      opts.onUpdate({ ...current, stage: "running", jobState: `retrying (${transient}/${AUTO_RETRIES})` });
      current = { ...current, stage: "running", error: undefined, errorKind: undefined };
      await sleep(Math.min(2000 * 2 ** (transient - 1), 30_000));
      continue;
    }
    opts.onUpdate(current, step.outcome);
    if (current.stage !== "running") return { job: current, outcome: step.outcome };
    transient = 0;
    await sleep(opts.pollMs ?? 2000);
  }
  return { job: current };
}

export type RetryDecision = { job: JobTrack } | { needsConfirmation: true; reason: string };

/** How a failed job continues; see the module comment. */
export function retryJob(job: JobTrack, opts: { confirmNewCharge?: boolean } = {}): RetryDecision {
  if (job.stage !== "failed") return { job };
  if (job.errorKind === "transport") return { job: { ...job, stage: "pending", error: undefined, errorKind: undefined } };
  if (job.providerRequestId && !opts.confirmNewCharge)
    return { needsConfirmation: true, reason: "The provider already accepted this job; trying again starts a new, separately charged job." };
  return { job: { jobId: newId("job"), stage: "pending", abandonedJobIds: [...(job.abandonedJobIds ?? []), job.jobId] } };
}

/** Honest one-line status from real job states (no invented percentages). */
export function jobStatus(job: JobTrack | undefined, doing: string, done: string): string {
  if (!job || job.stage === "pending") return `${doing} · waiting`;
  if (job.stage === "done") return done;
  if (job.stage === "failed") return `Failed: ${job.error ?? "unknown error"}`;
  return `${doing} · ${job.jobState ?? "sending"}`;
}

/** Mask asset IDs from a finished find. */
export function masksOf(outcome: Outcome | undefined): string[] {
  return outcome && "maskAssets" in outcome ? outcome.maskAssets.map((a) => a.id) : [];
}
