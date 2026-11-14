// GET ?projectId=: observations ordered by sourceTimeUs, then sequence.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ sourceId: string }>((ctx, request, { sourceId }) =>
  api.readSource(ctx, request, sourceId, "observations"),
);
