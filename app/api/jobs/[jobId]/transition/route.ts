// POST { projectId, to, patch }: move a job along JOB_TRANSITIONS.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route<{ jobId: string }>((ctx, request, { jobId }) => api.transitionJob(ctx, request, jobId));
