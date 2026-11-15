// GET: head revision (or ?revision=n). POST: compare-and-swap save (SaveRevisionRequest).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

type Params = { projectId: string; takeId: string };

export const GET = route<Params>((ctx, request, { projectId, takeId }) =>
  api.getRevision(ctx, request, projectId, takeId),
);
export const POST = route<Params>((ctx, request, { projectId, takeId }) =>
  api.saveRevision(ctx, request, projectId, takeId),
);
