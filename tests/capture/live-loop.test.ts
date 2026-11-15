/**
 * HK-011 CP-022: the live-call selector (pure policy). Simulated clocks only;
 * the real-call evidence is in docs/changes/HK-011.md.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_LOOP, LiveLoopPolicy, ObjectTracker, coverageScore, iou, type LiveMask } from "@/lib/capture/live-loop";

const T0 = 1_000_000;
const evidence = (id: string, atMs: number) => ({ observationId: id, mode: "evidence" as const, receivedAtMs: atMs });
const mask = (id: string, areaFraction: number, touchesEdge = false): LiveMask => ({ assetId: id, areaFraction, touchesEdge });

/** Run a segmentation of `obs` that returns `masks`, started now and finished `latencyMs` later. */
function segment(p: LiveLoopPolicy, obs: string, receivedAtMs: number, masks: LiveMask[], now: number, latencyMs = 4_000) {
  expect(p.next(now)).toEqual({ kind: "segment", observationId: obs });
  p.segmentStarted(obs, now);
  expect(p.next(now + 1)).toMatchObject({ kind: "wait" });
  p.segmentFinished(obs, masks, receivedAtMs, now + latencyMs);
  return now + latencyMs;
}

describe("LiveLoopPolicy", () => {
  it("segments the newest fresh evidence frame, ignoring previews and frames from before the call", () => {
    const p = new LiveLoopPolicy(T0);
    p.offerFrame(evidence("obs_old", T0 - 1));
    p.offerFrame({ observationId: "obs_p", mode: "preview", receivedAtMs: T0 + 100 });
    expect(p.next(T0 + 200)).toEqual({ kind: "wait", reason: "waiting for a fresh evidence frame" });
    p.offerFrame(evidence("obs_a", T0 + 300));
    p.offerFrame(evidence("obs_b", T0 + 900));
    p.offerFrame(evidence("obs_b", T0 + 900)); // repeated listing
    expect(p.next(T0 + 1_000)).toEqual({ kind: "segment", observationId: "obs_b" });
    expect(p.counts).toMatchObject({ framesOffered: 4, previewsIgnored: 1, beforeStartIgnored: 1, replacedBeforeSegment: 1 });
  });

  it("drops a stale frame instead of segmenting it", () => {
    const p = new LiveLoopPolicy(T0);
    p.offerFrame(evidence("obs_a", T0));
    expect(p.next(T0 + DEFAULT_LIVE_LOOP.freshMs + 1)).toMatchObject({ kind: "wait" });
    expect(p.counts.staleDropped).toBe(1);
  });

  it("paces segmentations and lets a newer frame replace the candidate only with clearly better coverage", () => {
    const p = new LiveLoopPolicy(T0);
    p.captureStarted(T0, 35);
    p.offerFrame(evidence("obs_1", T0 + 500));
    let now = segment(p, "obs_1", T0 + 500, [mask("m1", 0.1), mask("m1b", 0.02)], T0 + 600);
    expect(p.candidate).toMatchObject({ observationId: "obs_1", maskAssetId: "m1", coverage: 0.1 });
    p.offerFrame(evidence("obs_2", now));
    expect(p.next(now)).toEqual({ kind: "wait", reason: "pacing segmentations" });
    now = T0 + 600 + DEFAULT_LIVE_LOOP.minSegmentGapMs;
    now = segment(p, "obs_2", now - 100, [mask("m2", 0.11)], now); // +10 %: not enough
    expect(p.candidate?.observationId).toBe("obs_1");
    p.offerFrame(evidence("obs_3", now + 1_000));
    now = segment(p, "obs_3", now + 1_000, [mask("m3", 0.3, true)], now + 1_500); // 0.3 at the edge counts 0.15: +50 %
    expect(p.candidate).toMatchObject({ observationId: "obs_3", maskAssetId: "m3", coverage: 0.15 });
    expect(p.counts).toMatchObject({ segmentations: 3, superseded: 1, keptEarlier: 1 });
    expect(p.log.map((e) => e.event)).toEqual([
      "capture_started", "segment_started", "first_candidate", "segment_started", "kept_earlier_frame", "segment_started", "superseded",
    ]);
  });

  it("starts exactly one reconstruction before the planned end, waiting for an in-flight segmentation until capture ends", () => {
    const p = new LiveLoopPolicy(T0);
    p.captureStarted(T0, 35);
    p.offerFrame(evidence("obs_1", T0 + 500));
    segment(p, "obs_1", T0 + 500, [mask("m1", 0.1)], T0 + 600);
    const deadline = T0 + 35_000 - DEFAULT_LIVE_LOOP.reconstructLeadMs;
    p.offerFrame(evidence("obs_2", deadline - 2_000));
    expect(p.next(deadline - 1_500)).toEqual({ kind: "segment", observationId: "obs_2" });
    p.segmentStarted("obs_2", deadline - 1_500);
    expect(p.next(deadline + 10)).toMatchObject({ kind: "wait", reason: "segmentation in flight" });
    p.segmentFinished("obs_2", [mask("m2", 0.2)], deadline - 2_000, deadline + 3_000);
    expect(p.next(deadline + 3_000)).toEqual({ kind: "reconstruct", observationId: "obs_2", maskAssetId: "m2", reason: "planned end of capture approaching" });
    p.reconstructStarted(deadline + 3_000);
    expect(p.reconstruction).toMatchObject({ observationId: "obs_2", beforeHangUp: true });
    p.offerFrame(evidence("obs_3", deadline + 4_000));
    expect(p.next(deadline + 9_000)).toEqual({ kind: "done", reason: "reconstruction started" });
    expect(p.log.filter((e) => e.event === "reconstruct_started")).toHaveLength(1);
  });

  it("does not wait past the end of capture for a slow segmentation", () => {
    const p = new LiveLoopPolicy(T0);
    p.captureStarted(T0, 20);
    p.offerFrame(evidence("obs_1", T0 + 100));
    segment(p, "obs_1", T0 + 100, [mask("m1", 0.1)], T0 + 200);
    p.offerFrame(evidence("obs_2", T0 + 15_000));
    p.segmentStarted("obs_2", T0 + 15_500);
    expect(p.next(T0 + 20_000)).toMatchObject({ kind: "reconstruct", observationId: "obs_1" });
  });

  it("reconstructs at hang-up when the call ends early, and reports it as after hang-up", () => {
    const p = new LiveLoopPolicy(T0);
    p.captureStarted(T0, 35);
    p.offerFrame(evidence("obs_1", T0 + 100));
    segment(p, "obs_1", T0 + 100, [mask("m1", 0.05)], T0 + 200);
    p.callEnded(T0 + 8_000);
    expect(p.next(T0 + 8_000)).toMatchObject({ kind: "reconstruct", reason: "call ended" });
    p.reconstructStarted(T0 + 8_000);
    expect(p.reconstruction?.beforeHangUp).toBe(false);
  });

  it("never reconstructs without a usable mask, and stops when the call ends", () => {
    const p = new LiveLoopPolicy(T0);
    p.captureStarted(T0, 35);
    p.offerFrame(evidence("obs_1", T0 + 100));
    segment(p, "obs_1", T0 + 100, [mask("sliver", 0.001)], T0 + 200);
    expect(p.candidate).toBeNull();
    expect(p.counts.noUsableMask).toBe(1);
    p.callEnded(T0 + 30_000);
    expect(p.next(T0 + 30_000)).toEqual({ kind: "done", reason: "call ended with no usable object mask" });
  });

  it("keeps the spend under the cap, always leaving room for the one reconstruction", () => {
    const p = new LiveLoopPolicy(T0, { ...DEFAULT_LIVE_LOOP, maxSpendUsd: 0.05 });
    p.captureStarted(T0, 60);
    let now = T0;
    for (let i = 0; i < 6; i++) {
      p.offerFrame(evidence(`obs_${i}`, now));
      const action = p.next(now);
      if (action.kind !== "segment") break;
      now = segment(p, `obs_${i}`, now, [mask(`m${i}`, 0.01 * (i + 1)), mask(`x${i}`, 0.001), mask(`y${i}`, 0.001)], now) + DEFAULT_LIVE_LOOP.minSegmentGapMs;
    }
    // Each segmentation reserves 0.015 and needs 0.02 left for the reconstruction: two fit under 0.05.
    expect(p.counts.segmentations).toBe(2);
    expect(p.next(now)).toMatchObject({ kind: "reconstruct", reason: "segmentation cap or budget reached" });
    p.reconstructStarted(now);
    expect(p.spentUsd).toBeCloseTo(2 * 3 * 0.005 + 0.02, 9);
    expect(p.spentUsd).toBeLessThanOrEqual(0.05);
  });
});

describe("return-video coverage (CP-023)", () => {
  it("scores coverage from red (0) to green (1) by mask area and views", () => {
    expect(coverageScore(0, 0)).toBe(0);
    expect(coverageScore(0.04, 1)).toBeCloseTo(0.25 + 1 / 6, 9);
    expect(coverageScore(0.08, 3)).toBe(1);
    expect(coverageScore(0.5, 9)).toBe(1);
  });

  it("follows an object across segmentations by box overlap, keeping views through a miss", () => {
    expect(iou([0, 0, 1, 1], [0.5, 0, 1.5, 1])).toBeCloseTo(1 / 3, 9);
    const t = new ObjectTracker();
    const can = (dx: number) => ({ assetId: `m${dx}`, areaFraction: 0.05, touchesEdge: false, box: [0.4 + dx, 0.3, 0.6 + dx, 0.8] as [number, number, number, number] });
    const tub = { assetId: "tub", areaFraction: 0.02, touchesEdge: false, box: [0.7, 0.6, 0.85, 0.8] as [number, number, number, number] };
    expect(t.update([can(0), tub]).map((o) => [o.id, o.views])).toEqual([[1, 1], [2, 1]]);
    expect(t.update([can(0.05)]).map((o) => [o.id, o.views])).toEqual([[1, 2]]); // the tub was missed
    expect(t.update([can(0.1), tub]).map((o) => [o.id, o.views])).toEqual([[1, 3], [2, 2]]);
    expect(t.update([{ ...can(0), box: null }, { assetId: "x", areaFraction: 0.001, touchesEdge: false, box: [0, 0, 0.1, 0.1] }])).toEqual([]);
  });
});
