/**
 * Batch Generate, S4 phase 1 (PLAN v4): one user action reconstructs 1–3
 * objects from one captured frame as independent child pipelines on the
 * existing single-mask API. Each child runs segment → reconstruct, with one
 * durable job ID per stage, chosen and persisted before any request.
 *
 * Retry never resubmits a job that reached the provider. The route resumes any
 * existing job ID instead of submitting it again, so:
 *   - transport/HTTP error   → retry sends the SAME job ID (resume, or submit once if it never existed)
 *   - job failed, no request → retry gets a FRESH job ID for that stage (nothing was charged)
 *   - job failed with a provider request ID → a fresh job ID only with explicit
 *     confirmation (a new charge); the failed job itself is never sent again.
 */
import { newId, type Result } from "@/lib/contracts/common";
import type { ReconstructionOutcome, SegmentationOutcome } from "@/lib/reconstruction/runner";

export const MAX_BATCH = 3;

export interface BatchFrame {
  id: string;
  sourceId: string;
  projectId: string;
}

export type ChildStage = "segment" | "reconstruct" | "ready" | "failed";

export interface BatchChild {
  key: string;
  prompt: string;
  stage: ChildStage;
  /** Stage the child was in when it failed (what a retry resumes). */
  failedStage?: "segment" | "reconstruct";
  segmentJobId: string;
  meshJobId: string;
  maskAssetIds?: string[];
  /** Last state the server reported for the current job (queued, submitted, running, …). */
  jobState?: string;
  /** Provider request ID of the current job, once the provider accepted it. */
  providerRequestId?: string | null;
  error?: string;
  errorKind?: "transport" | "job";
  /** Jobs this child abandoned on retry (kept for the record; never sent again). */
  abandonedJobIds?: string[];
}

export interface Batch {
  id: string;
  frame: BatchFrame;
  takeId: string;
  children: BatchChild[];
}

export interface Command {
  projectId: string;
  sourceId: string;
  observationId: string;
  jobId: string;
  action: "segment" | "reconstruct";
  prompt?: string;
  maskAssetIds?: string[];
}

export type Outcome = ReconstructionOutcome | SegmentationOutcome;
export type Send = (command: Command) => Promise<Result<Outcome>>;

/** Starts a batch: 1–3 non-empty, distinct descriptions; every job ID chosen up front. */
export function startBatch(frame: BatchFrame, takeId: string, prompts: string[]): Batch | null {
  const clean = [...new Set(prompts.map((p) => p.trim().slice(0, 200)).filter(Boolean))].slice(0, MAX_BATCH);
  if (!clean.length) return null;
  return {
    id: newId("job").replace("job_", "batch_"),
    frame,
    takeId,
    children: clean.map((prompt, i) => ({ key: `c${i}`, prompt, stage: "segment", segmentJobId: newId("job"), meshJobId: newId("job") })),
  };
}

export function commandFor(batch: Batch, child: BatchChild): Command | null {
  const base = { projectId: batch.frame.projectId, sourceId: batch.frame.sourceId, observationId: batch.frame.id };
  if (child.stage === "segment") return { ...base, jobId: child.segmentJobId, action: "segment", prompt: child.prompt };
  if (child.stage === "reconstruct") return { ...base, jobId: child.meshJobId, action: "reconstruct", maskAssetIds: child.maskAssetIds };
  return null;
}

/** One request for one child; returns the updated child and, when it finishes, its mesh outcome. */
export async function stepChild(send: Send, batch: Batch, child: BatchChild): Promise<{ child: BatchChild; outcome?: ReconstructionOutcome }> {
  const command = commandFor(batch, child);
  if (!command) return { child };
  const stage = child.stage as "segment" | "reconstruct";
  let response: Result<Outcome>;
  try {
    response = await send(command);
  } catch (e) {
    response = { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: e instanceof Error ? e.message : String(e) } };
  }
  if (!response.ok)
    return { child: { ...child, stage: "failed", failedStage: stage, errorKind: "transport", error: `${response.error.code}: ${response.error.message}` } };
  const { job } = response.value;
  const seen = { ...child, jobState: job.state, providerRequestId: job.providerRequestId ?? null, error: undefined, errorKind: undefined };
  if (job.state === "failed" || job.state === "canceled")
    return { child: { ...seen, stage: "failed", failedStage: stage, errorKind: "job", error: job.error?.message ?? `job ${job.state}` } };
  if (job.state !== "succeeded") return { child: seen };
  if (stage === "segment") {
    const masks = (response.value as SegmentationOutcome).maskAssets.map((a) => a.id).slice(0, 1);
    if (!masks.length) return { child: { ...seen, stage: "failed", failedStage: "segment", errorKind: "job", error: `No "${child.prompt}" found in this frame` } };
    return { child: { ...seen, stage: "reconstruct", maskAssetIds: masks, jobState: undefined, providerRequestId: null } };
  }
  return { child: { ...seen, stage: "ready" }, outcome: response.value as ReconstructionOutcome };
}

export interface RunOptions {
  onUpdate(child: BatchChild, outcome?: ReconstructionOutcome): void;
  sleep?: (ms: number) => Promise<void>;
  alive?: () => boolean;
  pollMs?: number;
}

/** Drives one child until it is ready or failed; children of a batch run independently. */
export async function runChild(send: Send, batch: Batch, child: BatchChild, opts: RunOptions): Promise<BatchChild> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current = child;
  while ((opts.alive?.() ?? true) && (current.stage === "segment" || current.stage === "reconstruct")) {
    const before = current.stage;
    const step = await stepChild(send, batch, current);
    current = step.child;
    opts.onUpdate(current, step.outcome);
    if (current.stage === before) await sleep(opts.pollMs ?? 2000);
  }
  return current;
}

export type RetryDecision = { child: BatchChild } | { needsConfirmation: true; reason: string };

/** How a failed child continues. See the module comment for the three cases. */
export function retryChild(child: BatchChild, opts: { confirmNewCharge?: boolean } = {}): RetryDecision {
  if (child.stage !== "failed" || !child.failedStage) return { child };
  const stage = child.failedStage;
  const resumed: BatchChild = { ...child, stage, error: undefined, errorKind: undefined };
  if (child.errorKind === "transport") return { child: resumed }; // same job ID: resume, never a second submit
  const jobId = stage === "segment" ? child.segmentJobId : child.meshJobId;
  if (child.providerRequestId && !opts.confirmNewCharge)
    return { needsConfirmation: true, reason: "The provider already accepted this job; trying again starts a new, separately charged job." };
  const fresh = newId("job");
  return {
    child: {
      ...resumed,
      jobState: undefined,
      providerRequestId: null,
      abandonedJobIds: [...(child.abandonedJobIds ?? []), jobId],
      ...(stage === "segment" ? { segmentJobId: fresh } : { meshJobId: fresh }),
    },
  };
}

/** A short, honest status line from real job states (no invented percentages). */
export function childStatus(child: BatchChild): string {
  if (child.stage === "ready") return "Mesh ready";
  if (child.stage === "failed") return `Failed: ${child.error ?? "unknown error"}`;
  const what = child.stage === "segment" ? "Finding object" : "Reconstructing";
  return child.jobState ? `${what} · ${child.jobState}` : `${what} · sending`;
}
