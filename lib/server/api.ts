/**
 * Platform API handlers, independent of Next's routing so tests can call
 * them with a real backend and real actors. app/api/** route files are thin
 * wrappers (see ./route.ts).
 *
 * Order in every handler: authenticate (401) -> validate path/query/body with
 * parseContract (422) -> call the port -> map the Result through HTTP_STATUS.
 */
import {
  Asset,
  AssetId,
  CreateProjectRequest,
  ForkTakeRequest,
  IngestEnvelope,
  JobId,
  ObservationId,
  ProjectId,
  ReconstructionJob,
  SaveRevisionRequest,
  SourceId,
  SourceRegistration,
  TakeId,
  err,
  ok,
  type Actor,
  type Backend,
  type Project,
  type Result,
} from "@/lib/contracts";
import { UploadUrlRequest, JobTransitionRequest, RevisionNumberQuery } from "./http-schemas";
import { matchPath, readBody, readParam, readQuery, respond } from "./http";
import * as realStorage from "./storage";

export type PlatformBackend = Backend & { listProjects(actor: Actor): Promise<Result<Project[]>> };

/** Storage operations the handlers use (tests may substitute a gateway). */
export type StorageGateway = Pick<
  typeof realStorage,
  "checkUpload" | "checkObjectSize" | "createSignedUpload" | "createSignedDownload" | "verifyUpload" | "pathInBucket"
>;

export interface ApiContext {
  backend: PlatformBackend;
  actor: Actor;
  storage?: StorageGateway;
}

const signIn = () => respond(err("UNAUTHORIZED", "sign in required"));

/** Run steps in order; the first failed Result becomes the response. */
function first(...results: Result<unknown>[]): Response | null {
  for (const r of results) if (!r.ok) return respond(r);
  return null;
}

// ---------------------------------------------------------------------------
// Projects, takes, revisions (CT-003)
// ---------------------------------------------------------------------------

export async function listProjects(ctx: ApiContext): Promise<Response> {
  if (!ctx.actor) return signIn();
  return respond(await ctx.backend.listProjects(ctx.actor));
}

export async function createProject(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const body = await readBody(request, CreateProjectRequest);
  if (!body.ok) return respond(body);
  return respond(await ctx.backend.projects.createProject(ctx.actor, body.value), 201);
}

export async function getProject(ctx: ApiContext, projectId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const id = readParam("projectId", projectId, ProjectId);
  if (!id.ok) return respond(id);
  return respond(await ctx.backend.projects.getProject(ctx.actor, id.value));
}

export async function listTakes(ctx: ApiContext, projectId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const id = readParam("projectId", projectId, ProjectId);
  if (!id.ok) return respond(id);
  return respond(await ctx.backend.projects.listTakes(ctx.actor, id.value));
}

export async function forkTake(ctx: ApiContext, request: Request, projectId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const id = readParam("projectId", projectId, ProjectId);
  if (!id.ok) return respond(id);
  const body = await readBody(request, ForkTakeRequest);
  if (!body.ok) return respond(body);
  const mismatch = first(matchPath("projectId", body.value.projectId, id.value));
  if (mismatch) return mismatch;
  return respond(await ctx.backend.projects.forkTake(ctx.actor, body.value), 201);
}

export async function getRevision(
  ctx: ApiContext,
  request: Request,
  projectId: string,
  takeId: string,
): Promise<Response> {
  if (!ctx.actor) return signIn();
  const pid = readParam("projectId", projectId, ProjectId);
  const tid = readParam("takeId", takeId, TakeId);
  const bad = first(pid, tid);
  if (bad || !pid.ok || !tid.ok) return bad!;
  let revision: number | undefined;
  if (new URL(request.url).searchParams.has("revision")) {
    const q = readQuery(request, "revision", RevisionNumberQuery);
    if (!q.ok) return respond(q);
    revision = q.value;
  }
  return respond(await ctx.backend.projects.getRevision(ctx.actor, pid.value, tid.value, revision));
}

export async function saveRevision(
  ctx: ApiContext,
  request: Request,
  projectId: string,
  takeId: string,
): Promise<Response> {
  if (!ctx.actor) return signIn();
  const pid = readParam("projectId", projectId, ProjectId);
  const tid = readParam("takeId", takeId, TakeId);
  const bad = first(pid, tid);
  if (bad || !pid.ok || !tid.ok) return bad!;
  const body = await readBody(request, SaveRevisionRequest);
  if (!body.ok) return respond(body);
  const mismatch = first(
    matchPath("projectId", body.value.projectId, pid.value),
    matchPath("takeId", body.value.takeId, tid.value),
  );
  if (mismatch) return mismatch;
  return respond(await ctx.backend.projects.saveRevision(ctx.actor, body.value), 201);
}

// ---------------------------------------------------------------------------
// Ingestion (CT-002)
// ---------------------------------------------------------------------------

export async function registerSource(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const body = await readBody(request, SourceRegistration);
  if (!body.ok) return respond(body);
  return respond(await ctx.backend.ingestion.registerSource(ctx.actor, body.value), 201);
}

export async function ingest(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const body = await readBody(request, IngestEnvelope);
  if (!body.ok) return respond(body);
  const result = await ctx.backend.ingestion.ingest(ctx.actor, body.value);
  return respond(result, result.ok && result.value.status === "accepted" ? 201 : 200);
}

type SourceRead = "source" | "observations" | "latest";

export async function readSource(ctx: ApiContext, request: Request, sourceId: string, what: SourceRead): Promise<Response> {
  if (!ctx.actor) return signIn();
  const sid = readParam("sourceId", sourceId, SourceId);
  const pid = readQuery(request, "projectId", ProjectId);
  const bad = first(sid, pid);
  if (bad || !sid.ok || !pid.ok) return bad!;
  const gateway = ctx.backend.ingestion;
  if (what === "source") return respond(await gateway.getSource(ctx.actor, pid.value, sid.value));
  if (what === "observations") return respond(await gateway.listObservations(ctx.actor, pid.value, sid.value));
  return respond(await gateway.latestObservation(ctx.actor, pid.value, sid.value));
}

// ---------------------------------------------------------------------------
// Assets: signed direct upload, then metadata
// ---------------------------------------------------------------------------

export async function requestUpload(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const storage = ctx.storage ?? realStorage;
  const body = await readBody(request, UploadUrlRequest);
  if (!body.ok) return respond(body);
  const req = body.value;
  // With a kind, its media rules apply now. Without one (a generic byte store
  // such as capture's BlobStore.put), only the bucket cap applies here and the
  // kind rules apply when the metadata is recorded (POST /api/assets).
  const limits = req.kind
    ? storage.checkUpload(req.kind, req.mimeType, req.byteSize)
    : storage.checkObjectSize(req.byteSize);
  if (!limits.ok) return respond(limits);
  const project = await ctx.backend.projects.getProject(ctx.actor, req.projectId);
  if (!project.ok) return respond(project);
  const existing = await ctx.backend.assets.getAsset(ctx.actor, req.projectId, req.assetId);
  if (existing.ok) return respond(err("DUPLICATE", `asset ${req.assetId} is already registered`));
  const upload = await storage.createSignedUpload(req.projectId, req.assetId);
  if (!upload.ok) {
    if (upload.error.code !== "DUPLICATE") return respond(upload);
    // Bytes survived an interrupted upload, but metadata did not. Let only
    // this verified project owner compare the existing bytes before recovery.
    const path = realStorage.objectPath(req.projectId, req.assetId);
    const download = await storage.createSignedDownload(path);
    if (!download.ok) return respond(download);
    return respond(err("DUPLICATE", "asset bytes already exist; verify them before recording metadata", {
      storageKey: realStorage.storageKeyFor(req.projectId, req.assetId), recoveryDownloadUrl: download.value,
    }));
  }
  return respond(ok({ upload: upload.value, mimeType: req.mimeType, byteSize: req.byteSize }), 201);
}

export async function putAsset(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const storage = ctx.storage ?? realStorage;
  const body = await readBody(request, Asset);
  if (!body.ok) return respond(body);
  const asset = body.value;
  const project = await ctx.backend.projects.getProject(ctx.actor, asset.projectId);
  if (!project.ok) return respond(project);
  const limits = storage.checkUpload(asset.kind, asset.mimeType, asset.byteSize);
  if (!limits.ok) return respond(limits);
  const uploaded = await storage.verifyUpload(asset);
  if (!uploaded.ok) return respond(uploaded);
  return respond(await ctx.backend.assets.putAsset(ctx.actor, asset), 201);
}

export async function getAsset(ctx: ApiContext, request: Request, assetId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const storage = ctx.storage ?? realStorage;
  const aid = readParam("assetId", assetId, AssetId);
  const pid = readQuery(request, "projectId", ProjectId);
  const bad = first(aid, pid);
  if (bad || !aid.ok || !pid.ok) return bad!;
  const asset = await ctx.backend.assets.getAsset(ctx.actor, pid.value, aid.value);
  if (!asset.ok) return respond(asset);
  const path = storage.pathInBucket(asset.value.storageKey);
  if (!path) return respond(ok({ asset: asset.value, download: null }));
  const url = await storage.createSignedDownload(path);
  if (!url.ok) return respond(url);
  return respond(ok({ asset: asset.value, download: { url: url.value, expiresInSeconds: realStorage.SIGNED_DOWNLOAD_SECONDS } }));
}

// ---------------------------------------------------------------------------
// Jobs (CT-002)
// ---------------------------------------------------------------------------

export async function createJob(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const body = await readBody(request, ReconstructionJob);
  if (!body.ok) return respond(body);
  return respond(await ctx.backend.jobs.createJob(ctx.actor, body.value), 201);
}

/** GET /api/jobs?projectId&observationId: the jobs made from one captured frame, newest first. */
export async function listJobs(ctx: ApiContext, request: Request): Promise<Response> {
  if (!ctx.actor) return signIn();
  const pid = readQuery(request, "projectId", ProjectId);
  const oid = readQuery(request, "observationId", ObservationId);
  const bad = first(pid, oid);
  if (bad || !pid.ok || !oid.ok) return bad!;
  return respond(await ctx.backend.jobs.listJobs(ctx.actor, pid.value, oid.value));
}

export async function getJob(ctx: ApiContext, request: Request, jobId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const jid = readParam("jobId", jobId, JobId);
  const pid = readQuery(request, "projectId", ProjectId);
  const bad = first(jid, pid);
  if (bad || !jid.ok || !pid.ok) return bad!;
  return respond(await ctx.backend.jobs.getJob(ctx.actor, pid.value, jid.value));
}

export async function transitionJob(ctx: ApiContext, request: Request, jobId: string): Promise<Response> {
  if (!ctx.actor) return signIn();
  const jid = readParam("jobId", jobId, JobId);
  if (!jid.ok) return respond(jid);
  const body = await readBody(request, JobTransitionRequest);
  if (!body.ok) return respond(body);
  const { projectId, to, patch } = body.value;
  return respond(await ctx.backend.jobs.transitionJob(ctx.actor, projectId, jid.value, to, patch ?? {}));
}
