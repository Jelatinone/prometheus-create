import { describe, expect, it } from "vitest";
import { buildBoxGlb } from "@/lib/assets/glb";
import { MemoryBlobStore } from "@/lib/capture";
import type { Observation } from "@/lib/contracts";
import { childStatus, retryChild, runChild, startBatch, type Batch, type BatchChild, type Command, type Send } from "@/lib/editor/batch";
import { FalQueueError, type FalQueue, type FalStatus } from "@/lib/reconstruction/fal-queue";
import { reconstructionCommand } from "@/lib/reconstruction/http";
import { captureFixture, captureHarness, expectOk } from "../capture/helpers";

/**
 * S4 phase-1 batch Generate, driven through the real route handler
 * (`reconstructionCommand`) on MemoryBackend with a fake provider queue.
 * No network, no paid calls.
 */
class FakeFal implements FalQueue {
  submits: { endpoint: string; prompt?: string; requestId: string }[] = [];
  /** Descriptions whose segment submit throws before the provider accepts it (no request ID). */
  rejectSubmit = new Set<string>();
  /** Number of upcoming 3D jobs that fail after the provider accepted them (they have a request ID). */
  failNextMesh = 0;
  private failing = new Set<string>();
  private n = 0;
  private promptOf = new Map<string, string>();
  private maskPrompt = new Map<string, string>();
  constructor(private readonly maskPng: Uint8Array) {}
  async upload(_bytes: Uint8Array, _type: string, name: string) {
    return `fake://uploads/${name}`;
  }
  async submit(endpoint: string, input: Record<string, unknown>) {
    const prompt = typeof input.prompt === "string" ? input.prompt : this.maskPrompt.get(String((input.mask_urls as string[] | undefined)?.[0] ?? input.mask_url ?? ""));
    if (prompt && this.rejectSubmit.has(prompt) && endpoint.includes("image")) throw new FalQueueError("provider refused the request", 503);
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
    const prompt = this.promptOf.get(requestId) ?? "object";
    if (this.failing.has(requestId)) return { metadata: [] }; // completed, but no mesh: the job fails
    if (endpoint.includes("image")) {
      const url = `fake://mask-${requestId}.png`;
      this.maskPrompt.set(`fake://uploads/${url}`, prompt);
      return { masks: [{ url }] };
    }
    return { model_glb: { url: "fake://mesh.glb" }, metadata: [{ object_index: 0 }] };
  }
  async download(url: string) {
    if (url.startsWith("fake://mask")) return { bytes: this.maskPng, contentType: "image/png" };
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
  const blobs = new MemoryBlobStore();
  // Same blob store as the capture harness so frames and masks resolve.
  const ctxBlobs = (h as unknown as { blobs?: MemoryBlobStore }).blobs ?? blobs;
  let transportFailures = 0;
  const sends: Command[] = [];
  const send: Send = async (command) => {
    sends.push(command);
    if (transportFailures > 0) {
      transportFailures--;
      throw new TypeError("network error");
    }
    const request = new Request("http://test/api/reconstruction", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    const response = await reconstructionCommand(request, { backend: h.backend, actor: h.actor, blobs: ctxBlobs, fal: () => fal });
    const body = await response.json();
    return response.ok ? { ok: true, value: body } : { ok: false, error: body.error };
  };
  const batchOf = (prompts: string[]) => startBatch({ id: observation.id, sourceId: observation.sourceId, projectId: h.projectId }, "tk_requesting", prompts)!;
  const runAll = async (batch: Batch, children = batch.children) => {
    const done = await Promise.all(children.map((c) => runChild(send, batch, c, { onUpdate: () => {}, sleep: async () => {} })));
    return done;
  };
  return { h, fal, send, sends, batchOf, runAll, failNextSends: (n: number) => (transportFailures = n) };
}

const byPrompt = (children: BatchChild[], prompt: string) => children.find((c) => c.prompt === prompt)!;

describe("batch Generate (S4 phase 1)", () => {
  it("starts 1–3 distinct children with every job ID chosen before any request", () => {
    const b = startBatch({ id: "obs_x00", sourceId: "src_x00", projectId: "prj_x00" }, "tk_x00", [" chair ", "table", "chair", "", "lamp", "rug"])!;
    expect(b.children.map((c) => c.prompt)).toEqual(["chair", "table", "lamp"]);
    const ids = b.children.flatMap((c) => [c.segmentJobId, c.meshJobId]);
    expect(new Set(ids).size).toBe(6);
    expect(startBatch({ id: "obs_x00", sourceId: "src_x00", projectId: "prj_x00" }, "tk_x00", ["  "])).toBeNull();
  });

  it("one action runs three children to ready meshes, one durable job per stage", async () => {
    const { fal, batchOf, runAll } = await setup();
    const batch = batchOf(["chair", "table", "lamp"]);
    const done = await runAll(batch);
    expect(done.map((c) => c.stage)).toEqual(["ready", "ready", "ready"]);
    expect(done.every((c) => c.jobState === "succeeded" && c.providerRequestId)).toBe(true);
    expect(fal.count("image")).toBe(3);
    expect(fal.count("3d")).toBe(3);
    expect(childStatus(done[0])).toBe("Mesh ready");
  });

  it("partial failure keeps the others; retry of an unaccepted job uses a fresh ID and submits once", async () => {
    const { fal, batchOf, runAll, send } = await setup();
    fal.rejectSubmit.add("table");
    const batch = batchOf(["chair", "table"]);
    const done = await runAll(batch);
    expect(byPrompt(done, "chair").stage).toBe("ready");
    const failed = byPrompt(done, "table");
    expect(failed).toMatchObject({ stage: "failed", failedStage: "segment", errorKind: "job", providerRequestId: null });

    fal.rejectSubmit.clear();
    const retry = retryChild(failed);
    if (!("child" in retry)) throw new Error("expected a retry");
    expect(retry.child.segmentJobId).not.toBe(failed.segmentJobId);
    expect(retry.child.abandonedJobIds).toEqual([failed.segmentJobId]);
    const again = await runChild(send, batch, retry.child, { onUpdate: () => {}, sleep: async () => {} });
    expect(again.stage).toBe("ready");
    expect(fal.count("image")).toBe(2); // chair once, table once (the refused first try never reached the provider)
    expect(fal.count("3d")).toBe(2);
  });

  it("a job the provider accepted is never resubmitted; a new attempt needs explicit confirmation", async () => {
    const { fal, batchOf, send } = await setup();
    const batch = batchOf(["chair", "lamp"]);
    const run = (c: BatchChild) => runChild(send, batch, c, { onUpdate: () => {}, sleep: async () => {} });
    expect((await run(byPrompt(batch.children, "chair"))).stage).toBe("ready");
    fal.failNextMesh = 1;
    const failed = await run(byPrompt(batch.children, "lamp"));
    expect(failed).toMatchObject({ stage: "failed", failedStage: "reconstruct", errorKind: "job", jobState: "failed" });
    const meshSubmitsBefore = fal.count("3d");
    expect(failed.providerRequestId).toMatch(/^req-/);
    expect(fal.count("3d")).toBe(meshSubmitsBefore);

    expect(retryChild(failed)).toMatchObject({ needsConfirmation: true });
    // Sending the failed job's own ID again only resumes it: no new provider submission.
    const resent = await runChild(send, batch, { ...failed, stage: "reconstruct" }, { onUpdate: () => {}, sleep: async () => {} });
    expect(resent.stage).toBe("failed");
    expect(fal.count("3d")).toBe(meshSubmitsBefore);

    const confirmed = retryChild(failed, { confirmNewCharge: true });
    if (!("child" in confirmed)) throw new Error("expected a retry");
    expect(confirmed.child.meshJobId).not.toBe(failed.meshJobId);
    const again = await runChild(send, batch, confirmed.child, { onUpdate: () => {}, sleep: async () => {} });
    expect(again.stage).toBe("ready");
    expect(fal.count("3d")).toBe(meshSubmitsBefore + 1);
    expect(fal.count("image")).toBe(2); // the mask was reused, not segmented again
  });

  it("a transport error retries the same job ID, which the server resumes rather than resubmits", async () => {
    const { fal, batchOf, runAll, send, sends, failNextSends } = await setup();
    const fresh = batchOf(["table"]);
    failNextSends(1);
    const [failed] = await runAll(fresh);
    expect(failed).toMatchObject({ stage: "failed", errorKind: "transport", failedStage: "segment" });
    const retry = retryChild(failed);
    if (!("child" in retry)) throw new Error("expected a retry");
    expect(retry.child.segmentJobId).toBe(failed.segmentJobId);
    const imageBefore = fal.count("image");
    const again = await runChild(send, fresh, retry.child, { onUpdate: () => {}, sleep: async () => {} });
    expect(again.stage).toBe("ready");
    expect(fal.count("image")).toBe(imageBefore + 1);
    expect(sends.filter((s) => s.jobId === failed.segmentJobId).length).toBeGreaterThanOrEqual(2);
  });
});
