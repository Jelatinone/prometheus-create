// POST: create a reconstruction job (ReconstructionJob, state "queued").
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route((ctx, request) => api.createJob(ctx, request));
