// GET: one project (404 for another user's project).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ projectId: string }>((ctx, _request, { projectId }) => api.getProject(ctx, projectId));
export const PATCH = route<{ projectId: string }>((ctx, request, { projectId }) => api.renameProject(ctx, request, projectId));
