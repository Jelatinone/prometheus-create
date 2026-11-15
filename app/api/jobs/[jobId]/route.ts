// GET ?projectId=: one job.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ jobId: string }>((ctx, request, { jobId }) => api.getJob(ctx, request, jobId));
