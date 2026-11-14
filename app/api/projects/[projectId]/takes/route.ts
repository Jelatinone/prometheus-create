// GET: take summaries. POST: fork a take at an exact revision (ForkTakeRequest).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ projectId: string }>((ctx, _request, { projectId }) => api.listTakes(ctx, projectId));
export const POST = route<{ projectId: string }>((ctx, request, { projectId }) => api.forkTake(ctx, request, projectId));
