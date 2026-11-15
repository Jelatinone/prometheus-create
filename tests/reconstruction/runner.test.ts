/**
 * Reconstruction job runner against MemoryBackend with a scripted FakeFal.
 * FAKE PROVIDER: these tests prove state handling and failure paths only.
 * They are never evidence that fal produced a mesh; the live proof is
 * recorded separately in docs/changes/HK-002.md with a real request ID.
 */
import { describe, expect, it } from "vitest";
import { buildBoxGlb } from "@/lib/assets/glb";
import { CONTRACTS, parseContract, type Observation, type ReconstructionJob } from "@/lib/contracts";
import { assetStorageKey, storeProjectAsset } from "@/lib/capture";
import {
  FalQueueError,
  SAM3D_OBJECTS_MODEL,
  backfillSplat,
  splatBackfillJobId,
  resumeReconstruction,
  runReconstruction,
  runSegmentation,
  type FalQueue,
  type FalStatus,
  type ReconstructionDeps,
} from "@/lib/reconstruction";
import { captureFixture, captureHarness, codeOf, expectOk } from "../capture/helpers";
import { reconstructionCommand } from "@/lib/reconstruction/http";
import { reconstructedObject } from "@/lib/editor/reconstruction";
import { emptyCaptureManifest } from "@/lib/capture/project";
import { buildZip, crc32 } from "@/lib/editor/project-archive";
import { buildSplatPly, readS1 } from "./splat-fixtures";

type Call = { op: string; requestId?: string; storedRequestId?: string | null };

class FakeFal implements FalQueue {
  calls: Call[] = [];
  statuses: (FalStatus | Error)[] = [{ status: "IN_QUEUE", queuePosition: 0 }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }];
  output: unknown = { model_glb: { url: "fake://mesh.glb" }, gaussian_splat: { url: "fake://scene.ply" }, metadata: [{ object_index: 0 }] };
  files: Record<string, Uint8Array> = { "fake://mesh.glb": buildBoxGlb({ size: [0.4, 0.9, 0.2] }) };
  submitError: Error | null = null;
  /** Lets a test observe the job store at the moment of the first poll. */
  onStatus: ((requestId: string) => Promise<void>) | null = null;
  private n = 0;

  async upload(_bytes: Uint8Array, _type: string, name: string) {
    this.calls.push({ op: `upload:${name}` });
    return `fake://uploads/${name}`;
  }
  inputs: Record<string, unknown>[] = [];
  async submit(endpointId: string, input: Record<string, unknown> = {}) {
    this.calls.push({ op: `submit:${endpointId}` });
    this.inputs.push(input);
    if (this.submitError) throw this.submitError;
    return { requestId: `req-fake-${++this.n}` };
  }
  async status(_endpointId: string, requestId: string) {
    this.calls.push({ op: "status", requestId });
    if (this.onStatus) await this.onStatus(requestId);
    const next = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
    if (next instanceof Error) throw next;
    return next;
  }
  async result() {
    this.calls.push({ op: "result" });
    return this.output;
  }
  async download(url: string) {
    this.calls.push({ op: `download:${url}` });
    const bytes = this.files[url];
    if (!bytes) throw new FalQueueError(`no such file ${url}`, 404);
    return { bytes, contentType: "model/gltf-binary" };
  }
  count(prefix: string) {
    return this.calls.filter((c) => c.op.startsWith(prefix)).length;
  }
}

async function setup(fal = new FakeFal(), poll: ReconstructionDeps["poll"] = { intervalMs: 1000, timeoutMs: 60_000 }) {
  let clock = new Date("2026-11-14T20:00:00.000Z");
  const h = await captureHarness({ clock: () => clock });
  const image = expectOk(await h.ingestor.ingestImage({ bytes: captureFixture("upright-64x48.png"), adapter: "upload" }));
  const observation: Observation = expectOk(await h.backend.ingestion.latestObservation(h.actor, h.projectId, image.source.id));
  // PNG fixture stands in for a mask on the frame's exact pixel grid.
  const mask = expectOk(
    await storeProjectAsset({ assets: h.backend.assets, blobs: h.blobs, actor: h.actor }, h.projectId, captureFixture("upright-64x48.png"), {
      kind: "mask",
      mimeType: "image/png",
      origin: "editor",
    }),
  );
  const deps: ReconstructionDeps = {
    jobs: h.backend.jobs,
    assets: h.backend.assets,
    blobs: h.blobs,
    fal,
    actor: h.actor,
    now: () => clock,
    sleep: async (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    poll,
  };
  const request = { projectId: h.projectId, observation, maskAssetIds: [mask.id], targetObjectId: null, baseGeometryRevision: 0 };
  return { h, fal, deps, request, observation, mask };
}

const states = (job: ReconstructionJob) => job.history.map((e) => e.state);

describe("bounded HTTP reconstruction", () => {
  it("submits once, resumes the stored ID, and accepts only into the requesting take", async () => {
    const { h, fal, deps, request, observation } = await setup();
    const cmd = { projectId: h.projectId, sourceId: observation.sourceId, observationId: observation.id, jobId: "job_http_bound", action: "reconstruct", maskAssetIds: request.maskAssetIds };
    const ctx = { backend: h.backend, actor: h.actor, blobs: h.blobs, fal: () => fal };
    const send = (body = cmd) => reconstructionCommand(new Request("http://test/api/reconstruction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
    const first = await send(); expect(first.status).toBe(202);
    expect((await first.json()).job.state).toBe("submitted"); expect(fal.count("status")).toBe(0);
    await send(); await send(); const last = await send();
    const outcome = await last.json(); expect(outcome.job.state).toBe("succeeded");
    expect(fal.count("submit")).toBe(1);
    const manifest = emptyCaptureManifest(h.projectId);
    const object = expectOk(reconstructedObject(manifest, manifest.take.id, "Table", observation, outcome));
    expect(object.provenance.jobId).toBe(cmd.jobId);
    expect(codeOf(reconstructedObject(manifest, "tk_other", "Table", observation, outcome))).toBe("STALE_REVISION");
    expect(codeOf(reconstructedObject({ ...manifest, scene: { ...manifest.scene, objects: [object] } }, manifest.take.id, "Table", observation, outcome))).toBe("DUPLICATE");
    expect(deps.jobs).toBe(h.backend.jobs);
  });
  it("rejects unauthenticated/foreign requests before touching the provider", async () => {
    const { h, fal, observation } = await setup();
    const body = { projectId: h.projectId, sourceId: observation.sourceId, observationId: observation.id, jobId: "job_forbidden", action: "segment", prompt: "chair" };
    for (const actor of [null, { userId: "other" }]) {
      const res = await reconstructionCommand(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { backend: h.backend, actor, blobs: h.blobs, fal: () => { throw new Error("provider must not be constructed"); } });
      expect(res.status).toBe(actor ? 404 : 401);
    }
    expect(fal.calls).toHaveLength(0);
  });
  it("keeps the request resumable after a transient poll failure", async () => {
    const { fal, deps, request } = await setup();
    const started = expectOk(await runReconstruction({ ...deps, execution: "submit" }, request));
    fal.statuses = [new Error("network unavailable")];
    const failedPoll = await resumeReconstruction({ ...deps, execution: "poll-once" }, { projectId: request.projectId, jobId: started.job.id });
    expect(codeOf(failedPoll)).toBe("PROVIDER_UNAVAILABLE");
    fal.statuses = [{ status: "COMPLETED" }];
    const recovered = expectOk(await resumeReconstruction({ ...deps, execution: "poll-once" }, { projectId: request.projectId, jobId: started.job.id }));
    expect(recovered.job.state).toBe("succeeded"); expect(fal.count("submit")).toBe(1);
  });
});

describe("runReconstruction (fake provider: plumbing only)", () => {
  it("moves queued -> submitted -> running -> succeeded, stores owned mesh copies and a geometry candidate", async () => {
    const { h, fal, deps, request } = await setup();
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("succeeded");
    expect(states(out.job)).toEqual(["queued", "submitted", "running", "succeeded"]);
    expect(out.job.history.slice(1).every((e) => e.providerRequestId === "req-fake-1")).toBe(true);
    expect(parseContract(CONTRACTS["reconstruction-job"].schema, out.job).ok).toBe(true);
    expect(fal.count("submit")).toBe(1);
    expect(fal.calls.map((c) => c.op).slice(0, 3)).toEqual(["upload:frame.png", "upload:mask-0.png", `submit:${SAM3D_OBJECTS_MODEL}`]);

    expect(out.geometry).toMatchObject({
      geometryRevision: 1,
      normalization: { sourceUnits: "unknown", sourceUpAxis: "unknown", scaleApplied: 1, nodeTransformsBaked: false },
    });
    expect(out.apply).toEqual({ apply: true, reason: "result is current" });
    expect(out.meshAsset!.kind).toBe("mesh");
    expect(out.rawAsset!.kind).toBe("provider_raw");
    expect(out.job.output).toMatchObject({ meshAssetId: out.meshAsset!.id });
    expect(out.job.output!.rawAssetIds[0]).toBe(out.rawAsset!.id); // [1] is the provider pose JSON
    expect(expectOk(await h.blobs.get(assetStorageKey(h.projectId, out.meshAsset!.id))).bytes.byteLength).toBeGreaterThan(0);
  });

  it("persists providerRequestId before the first status poll", async () => {
    const { h, fal, deps, request } = await setup();
    const seen: (string | null)[] = [];
    fal.onStatus = async () => {
      const jobs = [...((h.backend as unknown as { projectsById: Map<string, { jobs: Map<string, ReconstructionJob> }> }).projectsById.get(h.projectId)!.jobs.values())];
      seen.push(jobs[0].providerRequestId);
    };
    expectOk(await runReconstruction(deps, request));
    expect(seen[0]).toBe("req-fake-1");
  });

  it("fails the job with PROVIDER_UNAVAILABLE on timeout, keeping the request id for reconciliation", async () => {
    const fal = new FakeFal();
    fal.statuses = [{ status: "IN_QUEUE", queuePosition: 3 }];
    const { h, deps, request } = await setup(fal, { intervalMs: 5_000, timeoutMs: 20_000 });
    const before = h.blobs.size;
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("failed");
    expect(out.job.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { providerRequestId: "req-fake-1" } });
    expect(out.job.providerRequestId).toBe("req-fake-1");
    expect(out.geometry).toBeNull();
    expect(out.meshAsset).toBeNull();
    expect(h.blobs.size).toBe(before);
    expect(fal.count("submit")).toBe(1);
  });

  it("fails with INVALID_GEOMETRY when the response has no GLB, creating no assets", async () => {
    const fal = new FakeFal();
    fal.output = { gaussian_splat: { url: "fake://scene.ply" }, metadata: [{ object_index: 0 }] };
    const { h, deps, request } = await setup(fal);
    const before = h.blobs.size;
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("failed");
    expect(out.job.error?.code).toBe("INVALID_GEOMETRY");
    expect(out.job.error?.message).toContain("model_glb");
    expect(h.blobs.size).toBe(before);
  });

  it("fails with INVALID_GEOMETRY when the GLB is corrupt", async () => {
    const fal = new FakeFal();
    fal.files["fake://mesh.glb"] = new TextEncoder().encode("<html>expired link</html>");
    const { deps, request } = await setup(fal);
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.error?.code).toBe("INVALID_GEOMETRY");
    expect(out.geometry).toBeNull();
  });

  it("records submit failures on the job: 422 as INVALID_SCHEMA, others as PROVIDER_UNAVAILABLE", async () => {
    for (const [error, code] of [
      [new FalQueueError("Unprocessable Entity", 422), "INVALID_SCHEMA"],
      [new FalQueueError("fetch failed"), "PROVIDER_UNAVAILABLE"],
    ] as const) {
      const fal = new FakeFal();
      fal.submitError = error;
      const { deps, request } = await setup(fal);
      const out = expectOk(await runReconstruction(deps, request));
      expect(states(out.job)).toEqual(["queued", "failed"]);
      expect(out.job.error?.code).toBe(code);
      expect(out.job.providerRequestId).toBeNull();
    }
  });

  it("fails after repeated status errors and when the provider reports an error", async () => {
    const flaky = new FakeFal();
    flaky.statuses = [new FalQueueError("503", 503)];
    const a = await setup(flaky, { intervalMs: 1000, timeoutMs: 60_000, maxStatusErrors: 3 });
    const outA = expectOk(await runReconstruction(a.deps, a.request));
    expect(outA.job.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(flaky.count("status")).toBe(3);

    const broken = new FakeFal();
    broken.statuses = [{ status: "COMPLETED", error: "CUDA out of memory" }];
    const b = await setup(broken);
    const outB = expectOk(await runReconstruction(b.deps, b.request));
    expect(outB.job.error?.message).toContain("CUDA out of memory");
    expect(broken.count("result")).toBe(0);
  });

  it("keeps a stale completion as assets but returns no geometry (canApplyJobResult)", async () => {
    const { deps, request } = await setup();
    const out = expectOk(await runReconstruction(deps, { ...request, baseGeometryRevision: 1, currentGeometryRevision: 2 }));
    expect(out.job.state).toBe("succeeded");
    expect(out.apply.apply).toBe(false);
    expect(out.apply.reason).toContain("stale");
    expect(out.geometry).toBeNull();
    expect(out.meshAsset).not.toBeNull();
  });

  it("rejects missing or misaligned masks before creating a job", async () => {
    const { h, fal, deps, request } = await setup();
    expect(codeOf(await runReconstruction(deps, { ...request, maskAssetIds: [] }))).toBe("INVALID_SCHEMA");
    const tall = expectOk(
      await storeProjectAsset({ assets: h.backend.assets, blobs: h.blobs, actor: h.actor }, h.projectId, captureFixture("rotated-orientation6.upright.png"), {
        kind: "mask",
        mimeType: "image/png",
        origin: "editor",
      }),
    );
    expect(codeOf(await runReconstruction(deps, { ...request, maskAssetIds: [tall.id] }))).toBe("INVALID_SCHEMA");
    expect(fal.calls).toEqual([]);
  });

  it("rejects non-PNG and mislabeled mask bytes before any provider calls", async () => {
    for (const mimeType of ["image/webp", "image/png"]) {
      const { h, fal, deps, request } = await setup();
      const bytes = captureFixture("lossless-64x48.webp");
      const mask = expectOk(await storeProjectAsset(
        { assets: h.backend.assets, blobs: h.blobs, actor: h.actor }, h.projectId,
        bytes, { kind: "mask", mimeType, origin: "editor" },
      ));
      expect(codeOf(await runReconstruction(deps, { ...request, maskAssetIds: [mask.id] }))).toBe("UNSUPPORTED_MEDIA");
      expect(fal.calls).toEqual([]);
    }
  });

  it("never resubmits a job id that already ran", async () => {
    const { fal, deps, request } = await setup();
    const first = expectOk(await runReconstruction(deps, { ...request, jobId: "job_once_only" }));
    const again = expectOk(await runReconstruction(deps, { ...request, jobId: "job_once_only" }));
    expect(again.job.id).toBe(first.job.id);
    expect(again.job.state).toBe("succeeded");
    expect(again.geometry?.assetId).toBe(first.geometry?.assetId);
    expect(fal.count("submit")).toBe(1);
  });
});

describe("resumeReconstruction (fake provider: plumbing only)", () => {
  it("polls a submitted job by its stored request id without submitting again", async () => {
    const { h, fal, deps, request, observation, mask } = await setup();
    const at = "2026-11-14T20:00:00.000Z";
    expectOk(
      await h.backend.jobs.createJob(h.actor, {
        schemaVersion: 1,
        id: "job_after_restart",
        projectId: h.projectId,
        kind: "reconstruct_object",
        state: "queued",
        provider: "fal",
        providerModel: SAM3D_OBJECTS_MODEL,
        providerRequestId: null,
        inputHash: observation.frame.contentHash,
        input: { observationId: observation.id, maskAssetIds: [mask.id], targetObjectId: null, baseGeometryRevision: 0 },
        history: [{ number: 1, state: "queued", at, providerRequestId: null, error: null }],
        output: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      }),
    );
    expectOk(await h.backend.jobs.transitionJob(h.actor, h.projectId, "job_after_restart", "submitted", { providerRequestId: "req-before-crash" }));
    fal.submitError = new Error("must not submit");
    const out = expectOk(await resumeReconstruction(deps, { projectId: request.projectId, jobId: "job_after_restart" }));
    expect(out.job.state).toBe("succeeded");
    expect(fal.count("submit")).toBe(0);
    expect(fal.calls.find((c) => c.op === "status")?.requestId).toBe("req-before-crash");

    // Resuming a finished job rebuilds the candidate from owned copies, with no provider calls.
    const calls = fal.calls.length;
    const again = expectOk(await resumeReconstruction(deps, { projectId: request.projectId, jobId: "job_after_restart" }));
    expect(again.geometry?.assetId).toBe(out.geometry?.assetId);
    expect(fal.calls.length).toBe(calls);
  });

  it("refuses to resume a queued job that has no provider request id", async () => {
    const { h, deps, observation, mask } = await setup();
    const at = "2026-11-14T20:00:00.000Z";
    expectOk(
      await h.backend.jobs.createJob(h.actor, {
        schemaVersion: 1,
        id: "job_never_confirmed",
        projectId: h.projectId,
        kind: "reconstruct_object",
        state: "queued",
        provider: "fal",
        providerModel: SAM3D_OBJECTS_MODEL,
        providerRequestId: null,
        inputHash: observation.frame.contentHash,
        input: { observationId: observation.id, maskAssetIds: [mask.id], targetObjectId: null, baseGeometryRevision: 0 },
        history: [{ number: 1, state: "queued", at, providerRequestId: null, error: null }],
        output: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      }),
    );
    expect(codeOf(await resumeReconstruction(deps, { projectId: h.projectId, jobId: "job_never_confirmed" }))).toBe("INVALID_TRANSITION");
  });
});

describe("runSegmentation (fake provider: plumbing only)", () => {
  it("stores a frame-aligned mask asset and records a succeeded segment job", async () => {
    const fal = new FakeFal();
    fal.output = { masks: [{ url: "fake://mask.png", width: 64, height: 48 }] };
    fal.files["fake://mask.png"] = captureFixture("upright-64x48.png");
    const { deps, observation, request } = await setup(fal);
    const out = expectOk(await runSegmentation(deps, { projectId: request.projectId, observation, prompt: "chair" }));
    expect(out.job).toMatchObject({ kind: "segment", state: "succeeded", providerModel: "fal-ai/sam-3/image" });
    expect(out.maskAssets).toHaveLength(1);
    expect(out.maskAssets[0].kind).toBe("mask");
    expect(out.job.output?.maskAssetIds).toEqual([out.maskAssets[0].id]);
  });

  it("asks for every matching instance (up to 3) and stores each mask, so one frame can yield 2-3 objects", async () => {
    /** Same pixels, different bytes: a tEXt chunk after IHDR (masks are content-addressed). */
    const variant = (png: Uint8Array, text: string) => {
      const body = new TextEncoder().encode(`Comment ${text}`);
      const chunk = new Uint8Array(12 + body.length);
      const view = new DataView(chunk.buffer);
      view.setUint32(0, body.length);
      chunk.set(new TextEncoder().encode("tEXt"), 4);
      chunk.set(body, 8);
      view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
      const ihdrEnd = 8 + 25;
      return new Uint8Array([...png.subarray(0, ihdrEnd), ...chunk, ...png.subarray(ihdrEnd)]);
    };
    const fal = new FakeFal();
    fal.output = { masks: [{ url: "fake://a.png" }, { url: "fake://b.png" }] };
    fal.files["fake://a.png"] = captureFixture("upright-64x48.png");
    fal.files["fake://b.png"] = variant(captureFixture("upright-64x48.png"), "second chair");
    const { deps, observation, request } = await setup(fal);
    const out = expectOk(await runSegmentation(deps, { projectId: request.projectId, observation, prompt: "chair" }));
    expect(fal.inputs[0]).toMatchObject({ return_multiple_masks: true, max_masks: 3, include_scores: true });
    expect(out.maskAssets).toHaveLength(2);
    expect(new Set(out.job.output?.maskAssetIds).size).toBe(2);
  });

  it("fails a non-PNG provider mask without storing an incompatible asset", async () => {
    const fal = new FakeFal();
    fal.output = { masks: [{ url: "fake://mask.png" }] };
    fal.files["fake://mask.png"] = captureFixture("lossless-64x48.webp");
    const { h, deps, observation, request } = await setup(fal);
    const before = h.blobs.size;
    const out = expectOk(await runSegmentation(deps, { projectId: request.projectId, observation, prompt: "chair" }));
    expect(out.job.state).toBe("failed");
    expect(out.job.error?.code).toBe("UNSUPPORTED_MEDIA");
    expect(out.maskAssets).toEqual([]);
    expect(h.blobs.size).toBe(before);
  });

  it("fails when the mask does not match the frame's pixel grid", async () => {
    const fal = new FakeFal();
    fal.output = { masks: [{ url: "fake://mask.png" }] };
    fal.files["fake://mask.png"] = captureFixture("rotated-orientation6.upright.png");
    const { deps, observation, request } = await setup(fal);
    const out = expectOk(await runSegmentation(deps, { projectId: request.projectId, observation, prompt: "chair" }));
    expect(out.job.state).toBe("failed");
    expect(out.job.error?.message).toContain("would not align");
  });
});

describe("splat persistence (fake provider: plumbing only)", () => {
  // The fake GLB is the 0.4 x 0.9 x 0.2 box, Y-up and centred. The provider's
  // object splat is the same object Z-up: splat (x, y, z) = GLB (x, -z, y).
  const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [0.2 * sx, 0.45 * sy, 0.1 * sz] as const)));
  const providerSplat = buildSplatPly(corners.map(([x, y, z]) => ({ p: [x, -z, y] as [number, number, number] })), { withNormals: true });
  const withBundle = (files: { name: string; bytes: Uint8Array }[]) => {
    const fal = new FakeFal();
    fal.output = { ...(fal.output as object), artifacts_zip: { url: "fake://bundle.zip" } };
    fal.files["fake://bundle.zip"] = buildZip(files);
    return fal;
  };

  it("stores the object splat aligned with the normalized mesh and records it on the job", async () => {
    const { h, deps, request } = await setup(withBundle([{ name: "object_00/splat.ply", bytes: providerSplat }]));
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("succeeded");
    expect(out.splatAsset).toMatchObject({ kind: "splat", mimeType: "model/ply", origin: "provider" });
    expect(out.job.output?.splatAssetId).toBe(out.splatAsset!.id);
    expect(out.splatNote).toBeNull();
    expect(parseContract(CONTRACTS["reconstruction-job"].schema, out.job).ok).toBe(true);
    const stored = expectOk(await h.blobs.get(assetStorageKey(h.projectId, out.splatAsset!.id))).bytes;
    const gaussians = readS1(stored);
    expect(gaussians).toHaveLength(8);
    const { min, max } = out.geometry!.localBounds;
    for (const axis of [0, 1, 2] as const) {
      const key = (["x", "y", "z"] as const)[axis];
      expect(Math.min(...gaussians.map((g) => g[key]))).toBeCloseTo(min[axis], 5);
      expect(Math.max(...gaussians.map((g) => g[key]))).toBeCloseTo(max[axis], 5);
    }
  });

  it("returns the stored splat when a succeeded job is resumed, without provider calls", async () => {
    const { deps, request, fal } = await setup(withBundle([{ name: "object_00/splat.ply", bytes: providerSplat }]));
    const first = expectOk(await runReconstruction(deps, request));
    const before = fal.calls.length;
    const again = expectOk(await resumeReconstruction(deps, { projectId: request.projectId, jobId: first.job.id }));
    expect(again.splatAsset?.id).toBe(first.splatAsset!.id);
    expect(fal.calls.length).toBe(before);
  });

  it("keeps a mesh-only success with a note when the splat is absent or unusable", async () => {
    const cases: [string, FakeFal][] = [
      ["no artifacts bundle", new FakeFal()],
      ["bundle has no object_00/splat.ply", withBundle([{ name: "object_00/mesh.glb", bytes: buildBoxGlb({ size: [1, 1, 1] }) }])],
      ["is not a PLY file", withBundle([{ name: "object_00/splat.ply", bytes: new TextEncoder().encode("not a ply") }])],
    ];
    const unreadable = withBundle([]);
    unreadable.files["fake://bundle.zip"] = new Uint8Array([1, 2, 3]);
    cases.push(["unreadable", unreadable]);
    for (const [note, fal] of cases) {
      const { deps, request } = await setup(fal);
      const out = expectOk(await runReconstruction(deps, request));
      expect(out.job.state, note).toBe("succeeded");
      expect(out.meshAsset, note).not.toBeNull();
      expect(out.splatAsset, note).toBeNull();
      expect(out.job.output?.splatAssetId, note).toBeNull();
      expect(out.splatNote, note).toContain(note);
    }
  });

  it("does not store the camera-posed gaussian_splat when the bundle is missing", async () => {
    const fal = new FakeFal();
    fal.files["fake://scene.ply"] = providerSplat;
    const { deps, request } = await setup(fal);
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.splatAsset).toBeNull();
    expect(fal.count("download:fake://scene.ply")).toBe(0);
  });
});

describe("backfillSplat: splat for an already-paid job (fake provider: plumbing only)", () => {
  const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [0.2 * sx, 0.45 * sy, 0.1 * sz] as const)));
  const providerSplat = buildSplatPly(corners.map(([x, y, z]) => ({ p: [x, -z, y] as [number, number, number] })), { withNormals: true });

  /** A job that succeeded mesh-only (as before CP-007); the provider result still has the bundle. */
  async function meshOnlyJob() {
    const fal = new FakeFal();
    const ctx = await setup(fal);
    const original = expectOk(await runReconstruction(ctx.deps, ctx.request));
    expect(original.job.output?.splatAssetId).toBeNull();
    fal.output = { ...(fal.output as object), artifacts_zip: { url: "fake://bundle.zip" } };
    fal.files["fake://bundle.zip"] = buildZip([{ name: "object_00/splat.ply", bytes: providerSplat }]);
    return { ...ctx, original };
  }

  it("adopts the original provider request (no submit) and stores a splat aligned with the same mesh asset", async () => {
    const { fal, deps, request, original } = await meshOnlyJob();
    const out = expectOk(await backfillSplat(deps, { projectId: request.projectId, jobId: original.job.id }));
    expect(fal.count("submit")).toBe(1); // only the original's
    expect(out.job.id).toBe(await splatBackfillJobId(original.job.id));
    expect(out.job.providerRequestId).toBe(original.job.providerRequestId);
    expect(states(out.job)).toEqual(["queued", "submitted", "succeeded"]);
    expect(out.job.inputHash).toBe(original.job.inputHash);
    expect(parseContract(CONTRACTS["reconstruction-job"].schema, out.job).ok).toBe(true);
    expect(out.meshAsset!.id).toBe(original.job.output!.meshAssetId);
    expect(out.splatAsset?.kind).toBe("splat");
    expect(out.job.output?.splatAssetId).toBe(out.splatAsset!.id);
    // The original is terminal and unchanged.
    expect(expectOk(await deps.jobs.getJob(deps.actor, request.projectId, original.job.id))).toEqual(original.job);
  });

  it("is idempotent: a repeat returns the stored splat with no provider calls", async () => {
    const { fal, deps, request, original } = await meshOnlyJob();
    const first = expectOk(await backfillSplat(deps, { projectId: request.projectId, jobId: original.job.id }));
    const calls = fal.calls.length;
    const again = expectOk(await backfillSplat(deps, { projectId: request.projectId, jobId: original.job.id }));
    expect(again.splatAsset?.id).toBe(first.splatAsset!.id);
    expect(fal.calls.length).toBe(calls);
  });

  it("returns the job's own splat when it already has one, creating no backfill job", async () => {
    const fal = new FakeFal();
    fal.output = { ...(fal.output as object), artifacts_zip: { url: "fake://bundle.zip" } };
    fal.files["fake://bundle.zip"] = buildZip([{ name: "object_00/splat.ply", bytes: providerSplat }]);
    const { deps, request } = await setup(fal);
    const withSplat = expectOk(await runReconstruction(deps, request));
    const out = expectOk(await backfillSplat(deps, { projectId: request.projectId, jobId: withSplat.job.id }));
    expect(out.job.id).toBe(withSplat.job.id);
    expect(out.splatAsset?.id).toBe(withSplat.splatAsset!.id);
    expect(codeOf(await deps.jobs.getJob(deps.actor, request.projectId, await splatBackfillJobId(withSplat.job.id)))).toBe("NOT_FOUND");
  });

  it("refuses unsuitable originals before touching the provider", async () => {
    const { fal, deps, request, h, observation } = await setup();
    const pending = expectOk(await runReconstruction({ ...deps, execution: "submit" }, request));
    const segment = expectOk(await runSegmentation({ ...deps, execution: "submit" }, { projectId: h.projectId, observation, prompt: "box" }));
    const before = fal.calls.length;
    expect(codeOf(await backfillSplat(deps, { projectId: request.projectId, jobId: pending.job.id }))).toBe("INVALID_TRANSITION");
    expect(codeOf(await backfillSplat(deps, { projectId: request.projectId, jobId: segment.job.id }))).toBe("INVALID_SCHEMA");
    expect(codeOf(await backfillSplat(deps, { projectId: request.projectId, jobId: "job_missing" }))).toBe("NOT_FOUND");
    expect(fal.calls.length).toBe(before);
  });

  it("fails only the backfill job when the provider result has expired", async () => {
    const { fal, deps, request, original } = await meshOnlyJob();
    fal.result = async () => {
      throw new FalQueueError("request not found", 404);
    };
    const out = expectOk(await backfillSplat(deps, { projectId: request.projectId, jobId: original.job.id }));
    expect(out.job.state).toBe("failed");
    expect(out.splatAsset).toBeNull();
    expect(fal.count("submit")).toBe(1);
    expect(expectOk(await deps.jobs.getJob(deps.actor, request.projectId, original.job.id)).state).toBe("succeeded");
  });

  it("attach_splat over HTTP backfills under the derived job and never submits", async () => {
    const { h, fal, original, observation } = await meshOnlyJob();
    const body = { projectId: h.projectId, sourceId: observation.sourceId, observationId: observation.id, jobId: original.job.id, action: "attach_splat" };
    const ctx = { backend: h.backend, actor: h.actor, blobs: h.blobs, fal: () => fal };
    const res = await reconstructionCommand(new Request("http://test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
    expect(res.status).toBe(200);
    const outcome = await res.json();
    expect(outcome.job.id).toBe(await splatBackfillJobId(original.job.id));
    expect(outcome.job.state).toBe("succeeded");
    expect(outcome.splatAsset.kind).toBe("splat");
    expect(fal.count("submit")).toBe(1);
  });
});

describe("bundle-first finish and provider placement (fake provider: plumbing only)", () => {
  const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => [0.2 * sx, 0.45 * sy, 0.1 * sz] as const)));
  const providerSplat = buildSplatPly(corners.map(([x, y, z]) => ({ p: [x, -z, y] as [number, number, number] })), { withNormals: true });
  const metadata = [{ object_index: 0, scale: [[0.5, 0.5, 0.5]], rotation: [[1, 0, 0, 0]], translation: [[0.1, 0.2, 1.5]], camera_pose: null }];
  const fullBundle = () => {
    const fal = new FakeFal();
    fal.output = { model_glb: { url: "fake://mesh.glb" }, artifacts_zip: { url: "fake://bundle.zip" }, metadata };
    fal.files["fake://bundle.zip"] = buildZip([
      { name: "object_00/mesh.glb", bytes: fal.files["fake://mesh.glb"] },
      { name: "object_00/splat.ply", bytes: providerSplat },
    ]);
    return fal;
  };

  it("downloads only the bundle when it holds the object mesh, and stores the pose with a placement", async () => {
    const fal = fullBundle();
    const { h, deps, request } = await setup(fal);
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("succeeded");
    expect(fal.count("download:")).toBe(1);
    expect(fal.count("download:fake://bundle.zip")).toBe(1);
    expect(out.splatAsset).not.toBeNull();
    const [glbId, poseId] = out.job.output!.rawAssetIds;
    expect(glbId).toBe(out.rawAsset!.id);
    const pose = expectOk(await h.blobs.get(assetStorageKey(h.projectId, poseId)));
    expect(JSON.parse(new TextDecoder().decode(pose.bytes))).toEqual(metadata);
    expect(out.placement).toMatchObject({ frame: "provider_camera", scale: 0.5 });
    expect(out.placementNote).toBeNull();
    // Identity pose: camera (0.1, 0.2, 1.5) -> scene (-0.1, 0.2, -1.5), shifted by the scaled recentering.
    expect(out.placement!.position[2]).toBeLessThan(0);
  });

  it("returns the same placement on resume without provider calls", async () => {
    const fal = fullBundle();
    const { deps, request } = await setup(fal);
    const first = expectOk(await runReconstruction(deps, request));
    const calls = fal.calls.length;
    const again = expectOk(await resumeReconstruction(deps, { projectId: request.projectId, jobId: first.job.id }));
    expect(again.placement).toEqual(first.placement);
    expect(fal.calls.length).toBe(calls);
  });

  it("falls back to model_glb when the bundle has no usable mesh, and reports missing poses", async () => {
    const fal = new FakeFal();
    fal.output = { model_glb: { url: "fake://mesh.glb" }, artifacts_zip: { url: "fake://bundle.zip" } };
    fal.files["fake://bundle.zip"] = buildZip([{ name: "object_00/mesh.glb", bytes: new TextEncoder().encode("not a glb") }]);
    const { deps, request } = await setup(fal);
    const out = expectOk(await runReconstruction(deps, request));
    expect(out.job.state).toBe("succeeded");
    expect(fal.count("download:fake://mesh.glb")).toBe(1);
    expect(out.placement).toBeNull();
    expect(out.placementNote).toMatch(/no object pose/);
    expect(out.job.output!.rawAssetIds).toHaveLength(1);
  });
});
