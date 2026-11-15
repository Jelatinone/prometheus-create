// GET: the jobs made from one captured frame (?projectId&observationId), newest first.
// POST: create a reconstruction job (ReconstructionJob, state "queued").
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route((ctx, request) => api.listJobs(ctx, request));
export const POST = route((ctx, request) => api.createJob(ctx, request));
