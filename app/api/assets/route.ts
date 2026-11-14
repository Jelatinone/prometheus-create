// POST: record an uploaded asset (Asset metadata; the bytes are already in storage).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route((ctx, request) => api.putAsset(ctx, request));
