// GET ?projectId=: the observation with the highest accepted sequence.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ sourceId: string }>((ctx, request, { sourceId }) =>
  api.readSource(ctx, request, sourceId, "latest"),
);
