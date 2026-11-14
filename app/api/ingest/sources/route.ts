// POST: register a source (SourceRegistration).
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route((ctx, request) => api.registerSource(ctx, request));
