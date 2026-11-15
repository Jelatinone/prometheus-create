/**
 * In-process `fetch` that dispatches platform API URLs to the real
 * app/api/**\/route.ts modules (no server process), and passes any other URL
 * (Supabase Storage signed URLs) to the network.
 *
 * Matching follows Next: static segments win over dynamic ones. ROUTE_FILES
 * must list every route file; tests/platform/http-backend.test.ts checks it
 * against the filesystem.
 */
import * as assetById from "@/app/api/assets/[assetId]/route";
import * as assets from "@/app/api/assets/route";
import * as uploadUrl from "@/app/api/assets/upload-url/route";
import * as ingest from "@/app/api/ingest/route";
import * as sourceLatest from "@/app/api/ingest/sources/[sourceId]/latest/route";
import * as sourceObservations from "@/app/api/ingest/sources/[sourceId]/observations/route";
import * as sourceById from "@/app/api/ingest/sources/[sourceId]/route";
import * as sources from "@/app/api/ingest/sources/route";
import * as jobById from "@/app/api/jobs/[jobId]/route";
import * as jobTransition from "@/app/api/jobs/[jobId]/transition/route";
import * as jobs from "@/app/api/jobs/route";
import * as projectById from "@/app/api/projects/[projectId]/route";
import * as revisions from "@/app/api/projects/[projectId]/takes/[takeId]/revisions/route";
import * as takes from "@/app/api/projects/[projectId]/takes/route";
import * as projects from "@/app/api/projects/route";
import * as reconstruction from "@/app/api/reconstruction/route";
import * as reconstructionFrames from "@/app/api/reconstruction/frames/route";

export const PLATFORM_ORIGIN = "http://platform.test";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST", Handler>>;

/** URL pattern -> route module, mirroring the app/api directory. */
export const ROUTE_FILES = {
  "/api/reconstruction": reconstruction,
  "/api/reconstruction/frames": reconstructionFrames,
  "/api/projects": projects,
  "/api/projects/[projectId]": projectById,
  "/api/projects/[projectId]/takes": takes,
  "/api/projects/[projectId]/takes/[takeId]/revisions": revisions,
  "/api/ingest": ingest,
  "/api/ingest/sources": sources,
  "/api/ingest/sources/[sourceId]": sourceById,
  "/api/ingest/sources/[sourceId]/observations": sourceObservations,
  "/api/ingest/sources/[sourceId]/latest": sourceLatest,
  "/api/assets": assets,
  "/api/assets/upload-url": uploadUrl,
  "/api/assets/[assetId]": assetById,
  "/api/jobs": jobs,
  "/api/jobs/[jobId]": jobById,
  "/api/jobs/[jobId]/transition": jobTransition,
} as unknown as Record<string, RouteModule>;

function match(pathname: string): { module: RouteModule; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  const candidates: { module: RouteModule; params: Record<string, string>; dynamic: number }[] = [];
  for (const [pattern, module] of Object.entries(ROUTE_FILES)) {
    const segments = pattern.split("/").filter(Boolean);
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let dynamic = 0;
    const ok = segments.every((segment, i) => {
      const name = /^\[(.+)\]$/.exec(segment)?.[1];
      if (!name) return segment === parts[i];
      params[name] = decodeURIComponent(parts[i]);
      dynamic++;
      return true;
    });
    if (ok) candidates.push({ module, params, dynamic });
  }
  candidates.sort((a, b) => a.dynamic - b.dynamic);
  return candidates[0] ?? null;
}

export const routeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== PLATFORM_ORIGIN) return globalThis.fetch(request);
  const found = match(url.pathname);
  if (!found) return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 });
  const handler = found.module[request.method as "GET" | "POST"];
  if (!handler) return new Response(null, { status: 405 });
  return handler(request, { params: Promise.resolve(found.params) });
};
