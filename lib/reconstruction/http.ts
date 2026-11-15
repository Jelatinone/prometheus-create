import { z } from "zod";
import { AssetId, JobId, ObservationId, ProjectId, SourceId, err, type Backend, type Actor } from "@/lib/contracts";
import type { BlobStore } from "@/lib/capture/blob-store";
import type { FalQueue } from "./fal-queue";
import { readBody, respond } from "@/lib/server/http";
import { backfillSplat, detectObjects, previewMesh, resumeReconstruction, resumeSegmentation, runReconstruction, runSegmentation, splatBackfillJobId } from "./runner";

// HTTP adapter shapes are local; shared contracts and backend ports remain unchanged.
export const ReconstructionCommand = z.strictObject({
  projectId: ProjectId, sourceId: SourceId, observationId: ObservationId, jobId: JobId,
  /**
   * attach_splat: `jobId` is a succeeded reconstruction without a splat. Repeat
   * the call until the returned (backfill) job settles; it never submits.
   * mesh_preview: `jobId` is a succeeded reconstruction; stores its cached
   * simplified mesh (CP-010) if missing. Local CPU only, never a provider call.
   */
  action: z.enum(["segment", "reconstruct", "poll", "attach_splat", "mesh_preview", "detect"]),
  prompt: z.string().trim().min(1).max(200).optional(),
  maskAssetIds: z.array(AssetId).min(1).max(1).optional(),
});

export async function reconstructionCommand(
  request: Request,
  ctx: { backend: Backend; actor: Actor; blobs: BlobStore; fal: () => FalQueue },
  lock: (key: string, action: () => Promise<Response>) => Promise<Response> = (_key, action) => action(),
): Promise<Response> {
  if (!ctx.actor) return respond(err("UNAUTHORIZED", "sign in required"));
  const parsed = await readBody(request, ReconstructionCommand);
  if (!parsed.ok) return respond(parsed);
  const cmd = parsed.value;
  const owner = await ctx.backend.projects.getProject(ctx.actor, cmd.projectId);
  if (!owner.ok) return respond(owner);
  const observations = await ctx.backend.ingestion.listObservations(ctx.actor, cmd.projectId, cmd.sourceId);
  if (!observations.ok) return respond(observations);
  const observation = observations.value.find(o => o.id === cmd.observationId);
  if (!observation) return respond(err("NOT_FOUND", "captured frame not found"));
  const deps = () => ({ ...ctx.backend, actor: ctx.actor, blobs: ctx.blobs, fal: ctx.fal(), execution: "poll-once" as const });
  if (cmd.action === "detect") return respond(await detectObjects(deps(), { projectId: cmd.projectId, observation }));
  if (cmd.action === "attach_splat") {
    // Lock the backfill job (the original is terminal and never changes).
    return lock(`${cmd.projectId}:${await splatBackfillJobId(cmd.jobId)}`, async () => {
      const original = await ctx.backend.jobs.getJob(ctx.actor, cmd.projectId, cmd.jobId);
      if (!original.ok) return respond(original);
      if (original.value.input.observationId !== observation.id) return respond(err("DUPLICATE", "job ID belongs to a different frame"));
      return respond(await backfillSplat(deps(), { projectId: cmd.projectId, jobId: cmd.jobId }));
    });
  }
  if (cmd.action === "mesh_preview") {
    return lock(`${cmd.projectId}:${cmd.jobId}`, async () => {
      const job = await ctx.backend.jobs.getJob(ctx.actor, cmd.projectId, cmd.jobId);
      if (!job.ok) return respond(job);
      if (job.value.input.observationId !== observation.id) return respond(err("DUPLICATE", "job ID belongs to a different frame"));
      return respond(await previewMesh(deps(), { projectId: cmd.projectId, jobId: cmd.jobId }));
    });
  }
  return lock(`${cmd.projectId}:${cmd.jobId}`, async () => {
    const existing = await ctx.backend.jobs.getJob(ctx.actor, cmd.projectId, cmd.jobId);
    if (!existing.ok && existing.error.code !== "NOT_FOUND") return respond(existing);
    const run = deps();
    if (existing.ok) {
      const job = existing.value;
      if (job.input.observationId !== observation.id || (cmd.action !== "poll" && job.kind !== (cmd.action === "segment" ? "segment" : "reconstruct_object")))
        return respond(err("DUPLICATE", "job ID already belongs to a different request"));
      if (job.state === "queued") return respond(err("INVALID_TRANSITION", "submission was not confirmed; reconcile this job before retrying"));
      if (job.kind === "segment") return respond(await resumeSegmentation(run, { ...cmd, observation }));
      return respond(await resumeReconstruction(run, cmd));
    }
    if (cmd.action === "poll") return respond(existing);
    if (cmd.action === "segment") {
      if (!cmd.prompt) return respond(err("INVALID_SCHEMA", "describe the object to reconstruct"));
      return respond(await runSegmentation({ ...run, execution: "submit" }, { ...cmd, observation, prompt: cmd.prompt }), 202);
    }
    if (!cmd.maskAssetIds?.length) return respond(err("INVALID_SCHEMA", "select an object mask first"));
    return respond(await runReconstruction({ ...run, execution: "submit" }, {
      ...cmd, observation, maskAssetIds: cmd.maskAssetIds, targetObjectId: null, baseGeometryRevision: 0,
    }), 202);
  });
}
