import { describe, expect, it } from "vitest";
import {
  TakeManifest,
  activeMapping,
  canApplyJobResult,
  canonicalJson,
  checkExpectedRevision,
  checkFrameLimits,
  checkFreshness,
  classifyFrame,
  collectAssetIds,
  forkManifest,
  frameToMicroseconds,
  hashJson,
  idPattern,
  microsecondsToFrame,
  newId,
  objectDimensions,
  parseContract,
  sourceTimeAtTakeFrame,
  transitionJob,
  type IngestEnvelope,
  type ReconstructionJob,
  type SourceMapping,
} from "@/lib/contracts";
import { loadFixture } from "../helpers/fixtures";

const original = () => loadFixture<TakeManifest>("take-manifest.original.json");
const alternate = () => loadFixture<TakeManifest>("take-manifest.alternate.json");

describe("ids", () => {
  it("newId produces ids that match their own pattern", () => {
    for (const kind of ["project", "take", "source", "observation", "asset"] as const) {
      expect(newId(kind)).toMatch(idPattern(kind));
    }
  });
  it("rejects an id with the wrong prefix", () => {
    expect("src_abc123").not.toMatch(idPattern("project"));
  });
});

describe("time (three independent clocks)", () => {
  const ntsc = { num: 30000, den: 1001 };
  it("converts frames to µs at rational rates", () => {
    expect(frameToMicroseconds(30, { num: 30, den: 1 })).toBe(1_000_000);
    expect(frameToMicroseconds(30000, ntsc)).toBe(1_001_000_000);
    expect(microsecondsToFrame(1_001_000_000, ntsc)).toBe(30000);
  });

  it("maps take frames to source time: t_source = sourceIn + rate * (t_take - takeIn)", () => {
    const m: SourceMapping = { sourceId: "src_clip", takeInFrame: 30, takeOutFrame: 90, sourceInUs: 5_000_000, rate: 1 };
    const rate = { num: 30, den: 1 };
    expect(sourceTimeAtTakeFrame(m, 29, rate)).toBeNull();
    expect(sourceTimeAtTakeFrame(m, 30, rate)).toBe(5_000_000);
    expect(sourceTimeAtTakeFrame(m, 60, rate)).toBe(6_000_000);
    expect(sourceTimeAtTakeFrame(m, 90, rate)).toBeNull();
    expect(sourceTimeAtTakeFrame({ ...m, rate: 0.5 }, 60, rate)).toBe(5_500_000);
  });

  it("a held frame (rate 0) keeps a constant source time", () => {
    const m: SourceMapping = { sourceId: "src_photo", takeInFrame: 0, takeOutFrame: 150, sourceInUs: 0, rate: 0 };
    const times = [0, 75, 149].map((f) => sourceTimeAtTakeFrame(m, f, { num: 30, den: 1 }));
    expect(times).toEqual([0, 0, 0]);
    expect(activeMapping([m], 149)).toBe(m);
    expect(activeMapping([m], 150)).toBeNull();
  });
});

describe("fork semantics", () => {
  it("copies into an independent take and leaves the original untouched", () => {
    const source = original();
    const before = canonicalJson(source);
    const fork = forkManifest(source, { newTakeId: "tk_fork_1", name: "Alt", parentRevisionId: "rev_orig_1" });

    fork.scene.objects[0].transform.position[0] = 99;
    fork.scene.objects[0].name = "Changed";

    expect(canonicalJson(source)).toBe(before);
    expect(fork.take.id).toBe("tk_fork_1");
    expect(fork.take.parent).toEqual({ takeId: source.take.id, revisionId: "rev_orig_1" });
    expect(parseContract(TakeManifest, fork).ok).toBe(true);
  });

  it("shares immutable assets by id", () => {
    const source = original();
    const fork = forkManifest(source, { newTakeId: "tk_fork_1", name: "Alt", parentRevisionId: "rev_orig_1" });
    expect(collectAssetIds(fork)).toEqual(collectAssetIds(source));
    expect(collectAssetIds(source)).toEqual(["ast_fixture_axis_box"]);
  });
});

describe("revisions", () => {
  it("compare-and-swap rejects a stale expected revision with details", () => {
    const stale = checkExpectedRevision({ number: 3, id: "rev_head_3" }, 2);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("REVISION_CONFLICT");
    expect(stale.error.details).toEqual({ expectedRevision: 2, currentRevision: 3, currentRevisionId: "rev_head_3" });
    expect(checkExpectedRevision({ number: 3, id: "rev_head_3" }, 3).ok).toBe(true);
  });

  it("manifest hash is stable across key order", async () => {
    const a = original();
    const reordered = JSON.parse(JSON.stringify({ scene: a.scene, take: a.take, projectId: a.projectId, schemaVersion: 1 }));
    expect(await hashJson(a)).toBe(await hashJson(reordered));
    expect(await hashJson(a)).not.toBe(await hashJson(alternate()));
  });

  it("dimensions apply the object's scale to its local bounds", () => {
    const [w, h, d] = objectDimensions(alternate().scene.objects[0]);
    expect([w, h, d].map((v) => +v.toFixed(6))).toEqual([0.48, 1.08, 0.24]);
  });
});

describe("ingestion rules", () => {
  const envelope = () => loadFixture<IngestEnvelope>("ingest-envelope.chert-frame.json");

  it("classifies duplicates, conflicts and out-of-order frames", () => {
    const e = envelope();
    expect(classifyFrame(e, undefined, null)).toEqual({ ok: true, value: { kind: "new", outOfOrder: false } });
    expect(classifyFrame(e, undefined, 7)).toEqual({ ok: true, value: { kind: "new", outOfOrder: true } });
    expect(classifyFrame(e, { id: "obs_a1b2c3", frame: { contentHash: e.frame.contentHash } }, 7)).toEqual({
      ok: true,
      value: { kind: "duplicate", observationId: "obs_a1b2c3" },
    });
    const conflict = classifyFrame(e, { id: "obs_a1b2c3", frame: { contentHash: "sha256:" + "0".repeat(64) } }, 7);
    expect(conflict.ok || conflict.error.code).toBe("DUPLICATE");
  });

  it("drops stale preview frames but never stale evidence", () => {
    const e = { ...envelope(), capturedAt: "2026-11-14T13:05:00.000-06:00" };
    const late = new Date("2026-11-14T19:05:05.000Z"); // 5 s later
    const preview = checkFreshness({ ...e, mode: "preview" }, late);
    expect(preview.ok || preview.error.code).toBe("STALE_FRAME");
    expect(checkFreshness({ ...e, mode: "evidence" }, late).ok).toBe(true);
  });

  it("rejects unsupported and oversized frames", () => {
    const e = envelope();
    const gif = checkFrameLimits({ ...e, frame: { ...e.frame, mimeType: "image/gif" } });
    expect(gif.ok || gif.error.code).toBe("UNSUPPORTED_MEDIA");
    const huge = checkFrameLimits({ ...e, frame: { ...e.frame, byteSize: 100 * 1024 * 1024 } });
    expect(huge.ok || huge.error.code).toBe("TOO_LARGE");
  });
});

describe("reconstruction jobs", () => {
  const queued = (): ReconstructionJob => ({
    ...loadFixture<ReconstructionJob>("reconstruction-job.succeeded.json"),
    state: "queued",
    provider: "fal",
    providerModel: "fal-ai/sam-3/3d-objects",
    history: [],
    output: null,
  });
  const at = "2026-11-14T14:00:00-06:00";

  it("follows queued -> submitted -> succeeded and logs each transition", () => {
    const submitted = transitionJob(queued(), "submitted", at, { providerRequestId: "req_123" });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const done = transitionJob(submitted.value, "succeeded", at, {
      output: { meshAssetId: "ast_mesh_001", splatAssetId: null, maskAssetIds: [], rawAssetIds: [] },
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.history.map((h) => h.state)).toEqual(["submitted", "succeeded"]);
  });

  it("refuses to submit without recording the provider request id", () => {
    const r = transitionJob(queued(), "submitted", at);
    expect(r.ok || r.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses transitions out of terminal states", () => {
    const failed = transitionJob(queued(), "failed", at, { error: { code: "PROVIDER_UNAVAILABLE", message: "down" } });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const retry = transitionJob(failed.value, "running", at);
    expect(retry.ok || retry.error.code).toBe("INVALID_TRANSITION");
  });

  it("never applies a stale result over newer geometry", () => {
    const job = loadFixture<ReconstructionJob>("reconstruction-job.succeeded.json");
    expect(canApplyJobResult(job, 0).apply).toBe(true);
    expect(canApplyJobResult(job, 2)).toMatchObject({ apply: false });
    expect(canApplyJobResult({ ...job, state: "canceled" }, 0).apply).toBe(false);
  });
});
