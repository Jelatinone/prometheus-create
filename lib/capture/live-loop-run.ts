/**
 * Drive LiveLoopPolicy against the running app during a call (HK-011 CP-022).
 * Transport-agnostic so tests can script it; live-loop-cli.mts wires fetch and
 * the agent's outbox. Every provider step goes through POST /api/reconstruction
 * with the caller's token: one durable job ID per step, polled (never resubmitted).
 */
import { DEFAULT_LIVE_LOOP, LiveLoopPolicy, type LiveLoopConfig, type LiveMask } from "./live-loop";

export interface LiveObservation {
  id: string;
  sourceId: string;
  mode: "evidence" | "preview";
  receivedAt: string;
}

export interface LiveTransport {
  /** The project's recent observations (GET /api/reconstruction/frames). */
  listFrames(): Promise<LiveObservation[]>;
  /** POST /api/reconstruction; returns the HTTP status and parsed JSON body. */
  command(body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

export type SessionState = "requested" | "bridge_ready" | "active" | "ended" | "failed" | null;

export interface LiveLoopRun {
  projectId: string;
  sourceId: string;
  prompt: string;
  /** Capture length after the first caller frame (the agent's --seconds). */
  seconds: number;
  config?: LiveLoopConfig;
  transport: LiveTransport;
  session: () => SessionState;
  newJobId: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
  /** Give up on the in-call loop this long after start (safety net). */
  loopTimeoutMs?: number;
  /** Keep polling the reconstruction after hang-up for at most this long. */
  settleTimeoutMs?: number;
  onUpdate?: (result: LiveLoopResult) => void;
}

interface JobRecord {
  jobId: string;
  observationId: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  state: string;
  error: string | null;
}

export interface LiveLoopResult {
  prompt: string;
  startedAtMs: number;
  config: LiveLoopConfig;
  segmentations: (JobRecord & { masks: LiveMask[] })[];
  reconstruction:
    | (JobRecord & { maskAssetId: string; beforeHangUp: boolean; meshAssetId: string | null; splatAssetId: string | null; previewMeshAssetId: string | null })
    | null;
  plannedEndMs: number | null;
  endedAtMs: number | null;
  stopReason: string | null;
  counts: LiveLoopPolicy["counts"];
  estimatedSpendUsd: number;
  log: LiveLoopPolicy["log"];
  errors: string[];
}

type Json = Record<string, unknown>;
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export async function runLiveLoop(opts: LiveLoopRun): Promise<LiveLoopResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tick = opts.tickMs ?? 1_000;
  const config = opts.config ?? DEFAULT_LIVE_LOOP;
  const policy = new LiveLoopPolicy(now(), config);
  const receivedAt = new Map<string, number>();
  const result: LiveLoopResult = {
    prompt: opts.prompt, startedAtMs: policy.startMs, config, segmentations: [], reconstruction: null,
    plannedEndMs: null, endedAtMs: null, stopReason: null, counts: policy.counts, estimatedSpendUsd: 0, log: policy.log, errors: [],
  };
  const update = () => {
    result.plannedEndMs = policy.plannedEndMs;
    result.endedAtMs = policy.endedAtMs;
    result.estimatedSpendUsd = Math.round(policy.spentUsd * 1000) / 1000;
    opts.onUpdate?.(result);
  };
  const base = { projectId: opts.projectId, sourceId: opts.sourceId };
  const send = async (body: Json) => {
    try {
      return await opts.transport.command({ ...base, ...body });
    } catch (e) {
      return { status: 0, body: { error: { code: "NETWORK", message: e instanceof Error ? e.message : String(e) } } };
    }
  };
  const errorOf = (r: { status: number; body: unknown }) => {
    const e = (r.body as { error?: { code?: string; message?: string } } | null)?.error;
    return `${r.status} ${e?.code ?? ""} ${e?.message ?? ""}`.trim();
  };
  const jobOf = (r: { body: unknown }) => (r.body as { job?: { state?: string } } | null)?.job;
  let segment: (JobRecord & { masks: LiveMask[] }) | null = null;
  const deadline = policy.startMs + (opts.loopTimeoutMs ?? (opts.seconds + 180) * 1000);

  for (;;) {
    const t = now();
    const state = opts.session();
    if (state === "active" || state === "ended" || state === "failed") policy.captureStarted(t, opts.seconds);
    if (state === "ended" || state === "failed") policy.callEnded(t);
    try {
      for (const o of await opts.transport.listFrames()) {
        if (o.sourceId !== opts.sourceId) continue;
        const at = Date.parse(o.receivedAt);
        receivedAt.set(o.id, at);
        policy.offerFrame({ observationId: o.id, mode: o.mode, receivedAtMs: at });
      }
    } catch (e) {
      result.errors.push(`list frames: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (segment) {
      const r = await send({ action: "poll", jobId: segment.jobId, observationId: segment.observationId });
      const job = jobOf(r);
      if (r.status >= 400 || r.status === 0) result.errors.push(`poll ${segment.jobId}: ${errorOf(r)}`);
      else if (job?.state && TERMINAL.has(job.state)) {
        segment.state = job.state;
        segment.finishedAtMs = now();
        if (job.state === "succeeded") {
          const all = (r.body as { maskStats?: ({ assetId: string; areaFraction: number; touchesEdge: boolean } | null)[] }).maskStats ?? [];
          const stats = all.filter((s): s is { assetId: string; areaFraction: number; touchesEdge: boolean } => !!s);
          segment.masks = stats.map((s) => ({ assetId: s.assetId, areaFraction: s.areaFraction, touchesEdge: s.touchesEdge }));
          policy.segmentFinished(segment.observationId, segment.masks, receivedAt.get(segment.observationId) ?? segment.startedAtMs, segment.finishedAtMs, all.length);
        } else {
          segment.error = JSON.stringify((jobOf(r) as { error?: unknown })?.error ?? null);
          policy.segmentFailed(segment.observationId, segment.finishedAtMs);
        }
        segment = null;
      }
    }
    const action = policy.next(now());
    if (action.kind === "segment") {
      const jobId = opts.newJobId();
      policy.segmentStarted(action.observationId, now());
      segment = { jobId, observationId: action.observationId, startedAtMs: now(), finishedAtMs: null, state: "submitting", error: null, masks: [] };
      result.segmentations.push(segment);
      const r = await send({ action: "segment", jobId, observationId: action.observationId, prompt: opts.prompt });
      if (r.status >= 400 || r.status === 0) {
        segment.state = "submit_failed";
        segment.error = errorOf(r);
        // A rejected request (4xx) never reached the provider; anything else may have been charged.
        policy.segmentFailed(action.observationId, now(), !(r.status >= 400 && r.status < 500));
        segment = null;
      } else segment.state = jobOf(r)?.state ?? "submitted";
    } else if (action.kind === "reconstruct") {
      const jobId = opts.newJobId();
      policy.reconstructStarted(now());
      const rec: NonNullable<LiveLoopResult["reconstruction"]> = {
        jobId, observationId: action.observationId, maskAssetId: action.maskAssetId, beforeHangUp: policy.reconstruction!.beforeHangUp,
        startedAtMs: now(), finishedAtMs: null, state: "submitting", error: null, meshAssetId: null, splatAssetId: null, previewMeshAssetId: null,
      };
      result.reconstruction = rec;
      const r = await send({ action: "reconstruct", jobId, observationId: action.observationId, maskAssetIds: [action.maskAssetId] });
      if (r.status >= 400 || r.status === 0) {
        rec.state = "submit_failed";
        rec.error = errorOf(r);
      } else rec.state = jobOf(r)?.state ?? "submitted";
      policy.log.push({ atMs: now(), event: "reconstruct_reason", detail: { reason: action.reason } });
    } else if (action.kind === "done") {
      result.stopReason = action.reason;
      update();
      break;
    }
    update();
    if (now() > deadline) {
      result.stopReason = "loop timeout";
      break;
    }
    await sleep(tick);
  }

  // After hang-up: keep polling the one reconstruction (one provider step per request) until it settles.
  const rec = result.reconstruction;
  if (rec && rec.state !== "submit_failed") {
    const settleBy = now() + (opts.settleTimeoutMs ?? 360_000);
    while (!TERMINAL.has(rec.state) && now() < settleBy) {
      await sleep(Math.max(tick, 3_000));
      const r = await send({ action: "poll", jobId: rec.jobId, observationId: rec.observationId });
      if (r.status >= 400 || r.status === 0) {
        result.errors.push(`poll ${rec.jobId}: ${errorOf(r)}`);
        continue;
      }
      const body = r.body as { job?: { state?: string; error?: unknown }; meshAsset?: { id: string } | null; splatAsset?: { id: string } | null; previewMeshAsset?: { id: string } | null };
      rec.state = body.job?.state ?? rec.state;
      if (TERMINAL.has(rec.state)) {
        rec.finishedAtMs = now();
        rec.meshAssetId = body.meshAsset?.id ?? null;
        rec.splatAssetId = body.splatAsset?.id ?? null;
        rec.previewMeshAssetId = body.previewMeshAsset?.id ?? null;
        if (rec.state !== "succeeded") rec.error = JSON.stringify(body.job?.error ?? null);
      }
      update();
    }
  }
  update();
  return result;
}
