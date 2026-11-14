// POST: signed direct-upload URL for one new asset (after an ownership check).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route((ctx, request) => api.requestUpload(ctx, request));
