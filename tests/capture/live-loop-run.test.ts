/**
 * HK-011 CP-022: the live-loop driver against a scripted route (no app, no
 * provider). Proves submit-once, polling, the single reconstruction and the
 * evidence record; the real call is recorded in docs/changes/HK-011.md.
 */
import { describe, expect, it } from "vitest";
import { runLiveLoop, type LiveObservation, type SessionState } from "@/lib/capture/live-loop-run";

function scripted() {
  let clock = 0;
  const frames: LiveObservation[] = [];
  const commands: Record<string, unknown>[] = [];
  const jobs = new Map<string, { kind: string; polls: number; observationId: string }>();
  let session: SessionState = "requested";
  const at = (ms: number) => new Date(ms).toISOString();
  // Evidence frames every 4 s; the second view shows the object larger.
  const schedule: [number, string, number][] = [[1_000, "obs_a", 0.06], [5_000, "obs_b", 0.12], [9_000, "obs_c", 0.125], [13_000, "obs_d", 0.13]];
  const coverage = new Map(schedule.map(([, id, c]) => [id, c]));
  const transport = {
    async listFrames() {
      for (const [t, id] of schedule) if (clock >= t && !frames.some((f) => f.id === id)) frames.push({ id, sourceId: "src_call", mode: "evidence", receivedAt: at(t) });
      return [...frames, { id: "obs_other", sourceId: "src_other", mode: "evidence" as const, receivedAt: at(clock) }];
    },
    async command(body: Record<string, unknown>) {
      commands.push(body);
      const id = body.jobId as string;
      if (body.action === "segment" || body.action === "reconstruct") {
        if (jobs.has(id)) return { status: 409, body: { error: { code: "DUPLICATE" } } };
        jobs.set(id, { kind: body.action as string, polls: 0, observationId: body.observationId as string });
        return { status: 202, body: { job: { state: "submitted" } } };
      }
      const job = jobs.get(id)!;
      job.polls++;
      if (job.polls < 3) return { status: 200, body: { job: { state: "running" } } };
      if (job.kind === "segment")
        return { status: 200, body: { job: { state: "succeeded" }, maskStats: [{ assetId: `mask_${job.observationId}`, areaFraction: coverage.get(job.observationId)!, touchesEdge: false }, null] } };
      return { status: 200, body: { job: { state: "succeeded" }, meshAsset: { id: "ast_mesh" }, splatAsset: { id: "ast_splat" }, previewMeshAsset: { id: "ast_preview" } } };
    },
  };
  let n = 0;
  return {
    transport, commands, jobs, frames,
    setSession: (s: SessionState) => (session = s),
    opts: {
      projectId: "prj_x", sourceId: "src_call", prompt: "chair", seconds: 30, transport,
      session: () => session, newJobId: () => `job_${++n}`, now: () => clock,
      sleep: async (ms: number) => { clock += ms; if (clock >= 500) session = clock >= 31_000 ? "ended" : "active"; },
    },
  };
}

describe("runLiveLoop", () => {
  it("segments during the call, supersedes on better coverage, reconstructs once before hang-up and settles it", async () => {
    const s = scripted();
    const result = await runLiveLoop(s.opts);
    const submits = s.commands.filter((c) => c.action !== "poll");
    expect(new Set(submits.map((c) => c.jobId)).size).toBe(submits.length); // every job ID submitted once
    expect(submits.filter((c) => c.action === "reconstruct")).toHaveLength(1);
    expect(s.commands.every((c) => c.projectId === "prj_x" && c.sourceId === "src_call")).toBe(true);
    expect(s.commands.some((c) => c.observationId === "obs_other")).toBe(false);
    // Four evidence frames, paced 5 s apart: all four are segmented (the cap), and only obs_b clearly improves on obs_a.
    expect(result.segmentations.map((j) => [j.observationId, j.state])).toEqual([["obs_a", "succeeded"], ["obs_b", "succeeded"], ["obs_c", "succeeded"], ["obs_d", "succeeded"]]);
    expect(result.counts).toMatchObject({ segmentations: 4, superseded: 1, keptEarlier: 2 });
    expect(result.reconstruction).toMatchObject({ observationId: "obs_b", maskAssetId: "mask_obs_b", beforeHangUp: true, state: "succeeded", meshAssetId: "ast_mesh", previewMeshAssetId: "ast_preview" });
    expect(result.reconstruction!.startedAtMs).toBeLessThan(31_000);
    expect(result.stopReason).toBe("reconstruction started");
    expect(result.estimatedSpendUsd).toBeCloseTo(4 * 2 * 0.005 + 0.02, 9);
    expect(result.errors).toEqual([]);
  });

  it("records a rejected segmentation without retrying it or charging the budget", async () => {
    const s = scripted();
    const command = s.transport.command;
    s.transport.command = async (body) => (body.action === "segment" ? { status: 400, body: { error: { code: "INVALID_SCHEMA", message: "bad prompt" } } } : command(body));
    const result = await runLiveLoop({ ...s.opts, loopTimeoutMs: 40_000 });
    expect(result.segmentations.every((j) => j.state === "submit_failed")).toBe(true);
    expect(result.reconstruction).toBeNull();
    expect(result.estimatedSpendUsd).toBe(0);
  });
});
