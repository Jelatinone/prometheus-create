// GET ?projectId=: asset metadata plus a short-lived signed download URL.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route<{ assetId: string }>((ctx, request, { assetId }) => api.getAsset(ctx, request, assetId));
