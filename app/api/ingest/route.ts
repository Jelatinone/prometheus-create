// POST: ingest one frame envelope (IngestEnvelope). Media is already in storage.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const POST = route((ctx, request) => api.ingest(ctx, request));
