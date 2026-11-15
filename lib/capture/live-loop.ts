/**
 * Live-call generation policy (HK-011 CP-022, ADR-004). Pure and clock-driven:
 * the driver (live-loop-cli.mts) feeds it frames and job results and does what
 * next() returns.
 *
 * - Only evidence frames received in this call are candidates; the newest
 *   fresh one waits to be segmented (older unsegmented ones are dropped).
 * - Segmentations are paced and capped, and every paid step is reserved
 *   against a spend cap before it starts.
 * - A frame's coverage is its best mask's area fraction, halved when the
 *   mask touches the frame edge (the object is probably cut off). A newer
 *   frame replaces the candidate only if it beats it by `improveRatio`.
 * - At most one reconstruction: started `reconstructLeadMs` before the
 *   planned end of capture, when segmentation can add nothing more (cap or
 *   budget), or at hang-up if the call ends first.
 */

export interface LiveLoopConfig {
  maxSegmentations: number;
  /** Minimum time between segmentation starts. */
  minSegmentGapMs: number;
  /** A frame older than this when it would be segmented is stale. */
  freshMs: number;
  /** A newer frame must beat the candidate's coverage by this factor. */
  improveRatio: number;
  /** Coverage multiplier for a mask touching the frame edge. */
  edgePenalty: number;
  /** Masks below this area fraction are not objects (noise, slivers). */
  minCoverage: number;
  /** Start the reconstruction this long before the planned end of capture. */
  reconstructLeadMs: number;
  maxSpendUsd: number;
  /** Worst-case segmentation cost reserved before it starts (up to 3 masks). */
  segmentReserveUsd: number;
  segmentCostPerMaskUsd: number;
  reconstructCostUsd: number;
}

export const DEFAULT_LIVE_LOOP: LiveLoopConfig = {
  maxSegmentations: 4,
  minSegmentGapMs: 5_000,
  freshMs: 8_000,
  improveRatio: 1.15,
  edgePenalty: 0.5,
  minCoverage: 0.005,
  reconstructLeadMs: 12_000,
  maxSpendUsd: 0.1,
  segmentReserveUsd: 0.015,
  segmentCostPerMaskUsd: 0.005,
  reconstructCostUsd: 0.02,
};

export interface LiveFrame {
  observationId: string;
  mode: "evidence" | "preview";
  /** Server arrival time (ms since epoch). */
  receivedAtMs: number;
}

export interface LiveMask {
  assetId: string;
  areaFraction: number;
  touchesEdge: boolean;
  /** Normalized [x0, y0, x1, y1] on its frame, when known. */
  box?: [number, number, number, number] | null;
}

export interface Candidate {
  observationId: string;
  maskAssetId: string;
  coverage: number;
  receivedAtMs: number;
}

export type LiveAction =
  | { kind: "segment"; observationId: string }
  | { kind: "reconstruct"; observationId: string; maskAssetId: string; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "done"; reason: string };

export interface LiveLogEntry {
  atMs: number;
  event: string;
  detail: Record<string, unknown>;
}

export class LiveLoopPolicy {
  readonly log: LiveLogEntry[] = [];
  readonly counts = { framesOffered: 0, previewsIgnored: 0, beforeStartIgnored: 0, staleDropped: 0, replacedBeforeSegment: 0, segmentations: 0, superseded: 0, keptEarlier: 0, noUsableMask: 0 };
  candidate: Candidate | null = null;
  spentUsd = 0;
  reservedUsd = 0;
  plannedEndMs: number | null = null;
  endedAtMs: number | null = null;
  reconstruction: { observationId: string; maskAssetId: string; atMs: number; beforeHangUp: boolean } | null = null;
  private pending: LiveFrame | null = null;
  private inFlight: { observationId: string; atMs: number } | null = null;
  private lastSegmentStartMs: number | null = null;
  private readonly seen = new Set<string>();

  constructor(
    readonly startMs: number,
    readonly config: LiveLoopConfig = DEFAULT_LIVE_LOOP,
  ) {}

  private note(atMs: number, event: string, detail: Record<string, unknown> = {}) {
    this.log.push({ atMs, event, detail });
  }

  /** Capture started (first caller frame); capture lasts `seconds` from then. */
  captureStarted(atMs: number, seconds: number) {
    if (this.plannedEndMs !== null) return;
    this.plannedEndMs = atMs + seconds * 1000;
    this.note(atMs, "capture_started", { plannedEndMs: this.plannedEndMs });
  }

  callEnded(atMs: number) {
    if (this.endedAtMs !== null) return;
    this.endedAtMs = atMs;
    this.note(atMs, "call_ended");
  }

  offerFrame(frame: LiveFrame) {
    if (this.seen.has(frame.observationId)) return;
    this.seen.add(frame.observationId);
    this.counts.framesOffered++;
    if (frame.mode !== "evidence") {
      this.counts.previewsIgnored++;
      return;
    }
    if (frame.receivedAtMs < this.startMs) {
      this.counts.beforeStartIgnored++;
      return;
    }
    if (this.pending && this.pending.receivedAtMs <= frame.receivedAtMs) this.counts.replacedBeforeSegment++;
    if (!this.pending || this.pending.receivedAtMs <= frame.receivedAtMs) this.pending = frame;
  }

  /** The best usable mask of a segmentation and its coverage, or null. */
  coverage(masks: LiveMask[]): { maskAssetId: string; coverage: number } | null {
    let best: { maskAssetId: string; coverage: number } | null = null;
    for (const m of masks) {
      if (m.areaFraction < this.config.minCoverage) continue;
      const coverage = m.areaFraction * (m.touchesEdge ? this.config.edgePenalty : 1);
      if (!best || coverage > best.coverage) best = { maskAssetId: m.assetId, coverage };
    }
    return best;
  }

  segmentStarted(observationId: string, atMs: number) {
    this.inFlight = { observationId, atMs };
    this.lastSegmentStartMs = atMs;
    this.counts.segmentations++;
    this.reservedUsd += this.config.segmentReserveUsd;
    if (this.pending?.observationId === observationId) this.pending = null;
    this.note(atMs, "segment_started", { observationId });
  }

  /** `chargedMasks`: masks the provider returned (and billed), including any that could not be measured. */
  segmentFinished(observationId: string, masks: LiveMask[], receivedAtMs: number, atMs: number, chargedMasks = masks.length) {
    if (this.inFlight?.observationId === observationId) this.inFlight = null;
    this.reservedUsd -= this.config.segmentReserveUsd;
    this.spentUsd += chargedMasks * this.config.segmentCostPerMaskUsd;
    const best = this.coverage(masks);
    if (!best) {
      this.counts.noUsableMask++;
      this.note(atMs, "no_usable_mask", { observationId, masks: masks.length });
      return;
    }
    const previous = this.candidate;
    if (previous && best.coverage <= previous.coverage * this.config.improveRatio) {
      this.counts.keptEarlier++;
      this.note(atMs, "kept_earlier_frame", { observationId, coverage: best.coverage, candidate: previous.observationId, candidateCoverage: previous.coverage });
      return;
    }
    if (previous) this.counts.superseded++;
    this.candidate = { observationId, maskAssetId: best.maskAssetId, coverage: best.coverage, receivedAtMs };
    this.note(atMs, previous ? "superseded" : "first_candidate", { observationId, coverage: best.coverage, previous: previous?.observationId ?? null, previousCoverage: previous?.coverage ?? null });
  }

  /** A segmentation that failed without charging (or charging unknown): release its reservation conservatively. */
  segmentFailed(observationId: string, atMs: number, charged = true) {
    if (this.inFlight?.observationId === observationId) this.inFlight = null;
    this.reservedUsd -= this.config.segmentReserveUsd;
    if (charged) this.spentUsd += this.config.segmentReserveUsd;
    this.note(atMs, "segment_failed", { observationId, charged });
  }

  reconstructStarted(atMs: number) {
    const c = this.candidate!;
    const beforeHangUp = this.endedAtMs === null;
    this.reconstruction = { observationId: c.observationId, maskAssetId: c.maskAssetId, atMs, beforeHangUp };
    this.spentUsd += this.config.reconstructCostUsd;
    this.note(atMs, "reconstruct_started", { ...this.reconstruction, coverage: c.coverage });
  }

  private canAfford(usd: number): boolean {
    return this.spentUsd + this.reservedUsd + usd <= this.config.maxSpendUsd + 1e-9;
  }

  next(nowMs: number): LiveAction {
    const c = this.config;
    if (this.reconstruction) return { kind: "done", reason: "reconstruction started" };
    const ended = this.endedAtMs !== null;
    const deadline = this.plannedEndMs !== null && nowMs >= this.plannedEndMs - c.reconstructLeadMs;
    const pastEnd = ended || (this.plannedEndMs !== null && nowMs >= this.plannedEndMs);
    const segmentsLeft = this.counts.segmentations < c.maxSegmentations && this.canAfford(c.segmentReserveUsd + c.reconstructCostUsd);

    if (this.candidate && this.canAfford(c.reconstructCostUsd)) {
      const reason = ended ? "call ended" : deadline ? "planned end of capture approaching" : !segmentsLeft && !this.inFlight ? "segmentation cap or budget reached" : null;
      // At the deadline, give an in-flight segmentation the chance to improve the choice until capture ends.
      if (reason && !(this.inFlight && !pastEnd)) return { kind: "reconstruct", observationId: this.candidate.observationId, maskAssetId: this.candidate.maskAssetId, reason };
    }
    if (this.inFlight) return { kind: "wait", reason: "segmentation in flight" };
    if (this.pending && nowMs - this.pending.receivedAtMs > c.freshMs) {
      this.counts.staleDropped++;
      this.note(nowMs, "stale_frame_dropped", { observationId: this.pending.observationId });
      this.pending = null;
    }
    if (ended && !this.pending) return { kind: "done", reason: this.candidate ? "budget left no room to reconstruct" : "call ended with no usable object mask" };
    if (!segmentsLeft) return this.candidate ? { kind: "done", reason: "budget left no room to reconstruct" } : { kind: "done", reason: "segmentation cap or budget reached with no usable object" };
    if (!this.pending) return { kind: "wait", reason: "waiting for a fresh evidence frame" };
    if (this.lastSegmentStartMs !== null && nowMs - this.lastSegmentStartMs < c.minSegmentGapMs) return { kind: "wait", reason: "pacing segmentations" };
    return { kind: "segment", observationId: this.pending.observationId };
  }
}

// ---------------------------------------------------------------------------
// Return-video overlay (HK-011 CP-023): recognised objects and their coverage.
// ---------------------------------------------------------------------------

/** Mask area at which an object counts as well covered (the best seen on the CP-022 call was 8 %). */
export const GOOD_AREA = 0.08;
/** Views (segmentations finding the object) at which it counts as well covered. */
export const GOOD_VIEWS = 3;

/** 0 (barely seen, red) to 1 (well covered, green): half area, half views. */
export function coverageScore(areaFraction: number, views: number): number {
  return 0.5 * Math.min(1, areaFraction / GOOD_AREA) + 0.5 * Math.min(1, views / GOOD_VIEWS);
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

export interface TrackedObject {
  id: number;
  box: [number, number, number, number];
  areaFraction: number;
  touchesEdge: boolean;
  views: number;
  score: number;
}

/**
 * Follows recognised objects across segmentations: a mask whose box overlaps
 * (IoU >= 0.3) an object from the previous segmentation is the same object
 * seen again. The camera moves slowly between keyframes, so overlap is a
 * reasonable identity test for a short call.
 */
export class ObjectTracker {
  private previous: TrackedObject[] = [];
  private nextId = 1;

  constructor(private readonly minCoverage = DEFAULT_LIVE_LOOP.minCoverage) {}

  /** The objects in this segmentation (usable masks with boxes), with views counted. */
  update(masks: LiveMask[]): TrackedObject[] {
    const used = new Set<number>();
    const current: TrackedObject[] = [];
    for (const m of [...masks].sort((a, b) => b.areaFraction - a.areaFraction)) {
      if (!m.box || m.areaFraction < this.minCoverage) continue;
      let match: TrackedObject | null = null;
      let best = 0.3;
      for (const p of this.previous) {
        const overlap = iou(p.box, m.box);
        if (!used.has(p.id) && overlap >= best) [match, best] = [p, overlap];
      }
      if (match) used.add(match.id);
      const views = (match?.views ?? 0) + 1;
      current.push({ id: match?.id ?? this.nextId++, box: m.box, areaFraction: m.areaFraction, touchesEdge: m.touchesEdge, views, score: coverageScore(m.areaFraction, views) });
    }
    // Objects missed this time are kept (with their last box), so one miss does not reset their views.
    this.previous = [...current, ...this.previous.filter((p) => !used.has(p.id))];
    return current;
  }
}
