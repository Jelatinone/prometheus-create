import { describe, expect, it } from "vitest";
import { buildBoxGlb } from "@/lib/assets/glb";
import { MemoryBlobStore } from "@/lib/capture";
import type { Observation } from "@/lib/contracts";
import {
  AUTO_RETRIES,
  addFind,
  findCommand,
  masksOf,
  meshCommand,
  objectsFromFind,
  retryJob,
  runJob,
  setRemoved,
  startBatch,
  startGenerate,
  stepJob,
  toGenerate,
  type Batch,
  type Command,
  type JobTrack,
  type Send,
} from "@/lib/editor/batch";
import { FalQueueError, type FalQueue, type FalStatus } from "@/lib/reconstruction/fal-queue";
import { reconstructionCommand } from "@/lib/reconstruction/http";
import { captureFixture, captureHarness, expectOk } from "../capture/helpers";

/**
 * Generate (S4 phase 1, dynamic count) through the real route handler
 * (`reconstructionCommand`) on MemoryBackend with a fake provider queue.
 * No network and no paid calls.
 */
class FakeFal implements FalQueue {
  submits: { endpoint: string; prompt?: string; requestId: string }[] = [];
  /** How many instances each description finds (default 1). */
  instances: Record<string, number> = {};
  rejectSubmit = new Set<string>();
  failNextMesh = 0;
  private failing = new Set<string>();
  private n = 0;
  private promptOf = new Map<string, string>();
  constructor(private readonly maskPng: Uint8Array) {}
  async upload(_bytes: Uint8Array, _type: string, name: string) {
    return `fake://uploads/${name}`;
  }
  async submit(endpoint: string, input: Record<string, unknown>) {
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    if (prompt && this.rejectSubmit.has(prompt)) throw new FalQueueError("provider refused the request", 503);
    const requestId = `req-${++this.n}`;
    if (endpoint.includes("3d") && this.failNextMesh > 0) {
      this.failNextMesh--;
      this.failing.add(requestId);
    }
    this.submits.push({ endpoint, prompt, requestId });
    if (prompt) this.promptOf.set(requestId, prompt);
    return { requestId };
  }
  async status(): Promise<FalStatus> {
    return { status: "COMPLETED" };
  }
  async result(endpoint: string, requestId: string) {
    if (this.failing.has(requestId)) return { metadata: [] }; // completed without a mesh: the job fails
    if (endpoint.includes("image")) {
      const count = this.instances[this.promptOf.get(requestId) ?? ""] ?? 1;
      return { masks: Array.from({ length: count }, (_, i) => ({ url: `fake://mask-${requestId}-${i}.png` })) };
    }
    return { model_glb: { url: "fake://mesh.glb" }, metadata: [{ object_index: 0 }] };
  }
  async download(url: string) {
    if (url.startsWith("fake://mask")) {
      // Distinct bytes per mask (trailing data after IEND) so each instance is its own asset.
      const tag = new TextEncoder().encode(url);
      const bytes = new Uint8Array(this.maskPng.length + tag.length);
      bytes.set(this.maskPng);
      bytes.set(tag, this.maskPng.length);
      return { bytes, contentType: "image/png" };
    }
    return { bytes: buildBoxGlb({ size: [0.4, 0.9, 0.2] }), contentType: "model/gltf-binary" };
  }
  count(endpointPart: string) {
    return this.submits.filter((s) => s.endpoint.includes(endpointPart)).length;
  }
}

async function setup() {
  const h = await captureHarness();
  const png = captureFixture("upright-64x48.png");
  const image = expectOk(await h.ingestor.ingestImage({ bytes: png, adapter: "upload" }));
  const observation: Observation = expectOk(await h.backend.ingestion.latestObservation(h.actor, h.projectId, image.source.id));
  const fal = new FakeFal(png);
  const blobs = (h as unknown as { blobs?: MemoryBlobStore }).blobs ?? new MemoryBlobStore();
  let transportFailures = 0;
  const sends: Command[] = [];
  const send: Send = async (command) => {
    sends.push(command);
    if (transportFailures > 0) {
      transportFailures--;
      throw new TypeError("network error");
    }
    const request = new Request("http://test/api/reconstruction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    const response = await reconstructionCommand(request, { backend: h.backend, actor: h.actor, blobs, fal: () => fal });
    const body = await response.json();
    return response.ok ? { ok: true, value: body } : { ok: false, error: body.error };
  };
  const quick = { onUpdate: () => {}, sleep: async () => {} };
  const batch: Batch = startBatch({ id: observation.id, sourceId: observation.sourceId, projectId: h.projectId }, "tk_requesting");
  /** Finds every description in the batch, adding one found object per returned mask. */
  const findAll = async (b: Batch) => {
    for (const f of b.finds) {
      if (f.job.stage === "done") continue;
      const r = await runJob(send, findCommand(b, f), f.job, quick);
      b = { ...b, finds: b.finds.map((x) => (x.key === f.key ? { ...x, job: r.job } : x)) };
      if (r.job.stage === "done") b = objectsFromFind(b, f, masksOf(r.outcome));
    }
    return b;
  };
  const generate = async (b: Batch) => {
    b = startGenerate(b);
    const results = await Promise.all(b.objects.filter((o) => o.mesh?.stage === "pending").map(async (o) => ({ key: o.key, ...(await runJob(send, meshCommand(b, o), o.mesh!, quick)) })));
    return { ...b, objects: b.objects.map((o) => ({ ...o, mesh: results.find((r) => r.key === o.key)?.job ?? o.mesh })) };
  };
  return { fal, send, sends, quick, findAll, generate, batch, failNextSends: (n: number) => (transportFailures = n) };
}

describe("Generate with a dynamic object count", () => {
  it("one description finds every instance; the count comes from the frame, not a constant", async () => {
    const { fal, findAll, generate, batch } = await setup();
    fal.instances = { chairs: 4, table: 1 };
    let b = await findAll(addFind(addFind(batch, "chairs"), "table"));
    expect(b.objects.map((o) => o.label)).toEqual(["chairs 1", "chairs 2", "chairs 3", "chairs 4", "table"]);
    expect(fal.count("image")).toBe(2); // one segmentation per description, however many instances it finds

    b = setRemoved(b, b.objects[1].key, true); // the person drops one they do not want
    expect(toGenerate(b)).toHaveLength(4);
    b = await generate(b);
    expect(b.objects.filter((o) => o.mesh?.stage === "done")).toHaveLength(4);
    expect(b.objects[1].mesh).toBeUndefined();
    expect(fal.count("3d")).toBe(4);
  });

  it("adding a description later finds more objects; repeated or blank descriptions are ignored", async () => {
    const { fal, findAll, batch } = await setup();
    fal.instances = { lamp: 2 };
    let b = await findAll(addFind(batch, "table"));
    expect(addFind(b, " TABLE ")).toBe(b);
    expect(addFind(b, "  ")).toBe(b);
    b = await findAll(addFind(b, "lamp"));
    expect(b.objects.map((o) => o.label)).toEqual(["table", "lamp 1", "lamp 2"]);
  });

  it("a description that finds nothing adds no objects", async () => {
    const { fal, findAll, batch } = await setup();
    fal.instances = { unicorn: 0 };
    const b = await findAll(addFind(batch, "unicorn"));
    expect(b.objects).toHaveLength(0);
  });
});

describe("retry never pays twice", () => {
  it("a refused find (no request ID) retries with a fresh job ID and submits once", async () => {
    const { fal, send, quick, batch } = await setup();
    fal.rejectSubmit.add("table");
    let b = addFind(batch, "table");
    const failed = await runJob(send, findCommand(b, b.finds[0]), b.finds[0].job, quick);
    expect(failed.job).toMatchObject({ stage: "failed", errorKind: "job", providerRequestId: null });
    fal.rejectSubmit.clear();
    const retry = retryJob(failed.job);
    if (!("job" in retry)) throw new Error("expected a retry");
    expect(retry.job.jobId).not.toBe(failed.job.jobId);
    expect(retry.job.abandonedJobIds).toEqual([failed.job.jobId]);
    b = { ...b, finds: [{ ...b.finds[0], job: retry.job }] };
    const again = await runJob(send, findCommand(b, b.finds[0]), retry.job, quick);
    expect(again.job.stage).toBe("done");
    expect(fal.count("image")).toBe(1);
  });

  it("a mesh job the provider accepted is never resubmitted; a new attempt needs confirmation", async () => {
    const { fal, send, quick, findAll, generate, batch } = await setup();
    fal.instances = { chairs: 2 };
    let b = await findAll(addFind(batch, "chairs"));
    fal.failNextMesh = 1;
    b = await generate(b);
    const failedObject = b.objects.find((o) => o.mesh?.stage === "failed")!;
    expect(b.objects.filter((o) => o.mesh?.stage === "done")).toHaveLength(1); // the other one is kept
    expect(failedObject.mesh).toMatchObject({ errorKind: "job", jobState: "failed" });
    expect(failedObject.mesh!.providerRequestId).toMatch(/^req-/);
    const meshSubmits = fal.count("3d");

    expect(retryJob(failedObject.mesh!)).toMatchObject({ needsConfirmation: true });
    const resent = await runJob(send, meshCommand(b, failedObject), { ...failedObject.mesh!, stage: "pending" }, quick);
    expect(resent.job.stage).toBe("failed");
    expect(fal.count("3d")).toBe(meshSubmits); // same ID: resumed, not resubmitted

    const confirmed = retryJob(failedObject.mesh!, { confirmNewCharge: true });
    if (!("job" in confirmed)) throw new Error("expected a retry");
    const object = { ...failedObject, mesh: confirmed.job };
    const again = await runJob(send, meshCommand(b, object), confirmed.job, quick);
    expect(again.job.stage).toBe("done");
    expect(fal.count("3d")).toBe(meshSubmits + 1);
    expect(fal.count("image")).toBe(1); // the mask was reused
  });

  it("network errors retry the same job ID automatically with backoff, then hand over", async () => {
    const { fal, send, sends, batch, failNextSends } = await setup();
    const b = addFind(batch, "table");
    const waits: number[] = [];
    const opts = { onUpdate: () => {}, sleep: async (ms: number) => void waits.push(ms) };
    failNextSends(2);
    const ok = await runJob(send, findCommand(b, b.finds[0]), b.finds[0].job, opts);
    expect(ok.job.stage).toBe("done");
    expect(new Set(sends.map((s) => s.jobId))).toEqual(new Set([b.finds[0].job.jobId]));
    expect(waits.slice(0, 2)).toEqual([2000, 4000]);
    expect(fal.count("image")).toBe(1);

    const b2 = addFind(b, "lamp");
    failNextSends(AUTO_RETRIES + 1);
    const given = await runJob(send, findCommand(b2, b2.finds[1]), b2.finds[1].job, opts);
    expect(given.job).toMatchObject({ stage: "failed", errorKind: "transport" });
    const retry = retryJob(given.job);
    expect("job" in retry && retry.job.jobId).toBe(b2.finds[1].job.jobId); // the person's retry also keeps the ID
  });

  it("a job locked by another request waits instead of failing", async () => {
    let calls = 0;
    const send: Send = async () =>
      ++calls === 1
        ? { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "this job is processing in another request; resume shortly" } }
        : { ok: false, error: { code: "NOT_FOUND", message: "gone" } };
    const job: JobTrack = { jobId: "job_lockedjob0001", stage: "running" };
    const cmd = { projectId: "prj_x00", sourceId: "src_x00", observationId: "obs_x00", jobId: job.jobId, action: "segment" as const, prompt: "x" };
    expect((await stepJob(send, cmd, job)).job.stage).toBe("running");
    expect((await stepJob(send, cmd, job)).job).toMatchObject({ stage: "failed", errorKind: "transport" });
  });
});
