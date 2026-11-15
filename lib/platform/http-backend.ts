/**
 * HttpBackend: the Backend ports over the platform HTTP API (app/api/**).
 *
 * Browser code in the editor and capture lanes uses this instead of
 * MemoryBackend; the semantics are the same (tests/platform runs the shared
 * conformance suite through it against the real route handlers).
 *
 * Identity: the `actor` argument only decides whether credentials are sent.
 * The server derives the user from the Supabase session cookie (browser,
 * default) or from a bearer token returned by `authorize` (scripts, agents).
 * A null actor sends no credentials, so the server answers UNAUTHORIZED.
 *
 * Results: success bodies are the port values; failures are the server's
 * ContractError. Network failures and non-contract responses (a host error
 * page, a proxy timeout) become PROVIDER_UNAVAILABLE with the HTTP status.
 *
 * Browser-safe: imports contract leaf modules only, never lib/server.
 */
import type { Asset } from "@/lib/contracts/asset";
import { ContractError, err, ok, type Result } from "@/lib/contracts/common";
import type { IngestEnvelope, IngestResult, JobState, ReconstructionJob } from "@/lib/contracts/ingestion";
import type { Actor, Backend } from "@/lib/contracts/ports";
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  ForkTakeRequest,
  ForkTakeResponse,
  Revision,
  SaveRevisionRequest,
  SaveRevisionResponse,
  TakeSummary,
} from "@/lib/contracts/revision";
import type { Project } from "@/lib/contracts/scene";
import type { Observation, Source, SourceRegistration } from "@/lib/contracts/source";

/** How a call made for `actor` authenticates. */
export interface Authorization {
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
}

export interface HttpBackendOptions {
  /** API origin, e.g. "https://app.example". Default "" (same origin). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default: session cookie for any actor, nothing for null. */
  authorize?: (actor: Actor) => Authorization | Promise<Authorization>;
  /** Called on every UNAUTHORIZED answer (e.g. to send the user to /login). */
  onUnauthorized?: (error: ContractError) => void;
}

/** A signed, short-lived download for an asset's bytes (never store it). */
export interface AssetDownload {
  asset: Asset;
  download: { url: string; expiresInSeconds: number } | null;
}

/** Response of POST /api/assets/upload-url. */
export interface SignedUpload {
  upload: { storageKey: string; bucket: string; path: string; signedUrl: string; token: string };
  mimeType: string;
  byteSize: number;
}

type JobPatch = Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">>;

const MAX_REVISION = 999_999_999;

const sessionCookie = (actor: Actor): Authorization => ({ credentials: actor ? "same-origin" : "omit" });

const enc = encodeURIComponent;

export class HttpBackend implements Backend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorize: (actor: Actor) => Authorization | Promise<Authorization>;
  private readonly onUnauthorized?: (error: ContractError) => void;

  constructor(options: HttpBackendOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.authorize = options.authorize ?? sessionCookie;
    this.onUnauthorized = options.onUnauthorized;
  }

  /** One API call; the building block for the ports and for PlatformBlobStore. */
  async request<T>(actor: Actor, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<Result<T>> {
    const auth = await this.authorize(actor);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...auth.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: auth.credentials,
      });
    } catch (error) {
      return err("PROVIDER_UNAVAILABLE", `platform API unreachable: ${(error as Error).message}`);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (response.ok) return ok(payload as T);

    const reported = ContractError.safeParse((payload as { error?: unknown } | undefined)?.error);
    const error: ContractError = reported.success
      ? reported.data
      : {
          code: response.status === 401 ? "UNAUTHORIZED" : "PROVIDER_UNAVAILABLE",
          message: `platform API answered HTTP ${response.status} without a contract error`,
          details: { status: response.status },
        };
    if (error.code === "UNAUTHORIZED") this.onUnauthorized?.(error);
    return { ok: false, error };
  }

  // -------------------------------------------------------------------------
  // Platform extras
  // -------------------------------------------------------------------------

  listProjects(actor: Actor): Promise<Result<Project[]>> {
    return this.request(actor, "GET", "/api/projects");
  }

  /** Asset metadata plus a short-lived signed download URL. */
  assetDownload(actor: Actor, projectId: string, assetId: string): Promise<Result<AssetDownload>> {
    return this.request(actor, "GET", `/api/assets/${enc(assetId)}?projectId=${enc(projectId)}`);
  }

  /** Signed direct-upload target for a new asset (kind optional; see lib/server/http-schemas). */
  requestUpload(
    actor: Actor,
    req: { projectId: string; assetId: string; mimeType: string; byteSize: number; kind?: Asset["kind"] },
  ): Promise<Result<SignedUpload>> {
    return this.request(actor, "POST", "/api/assets/upload-url", req);
  }

  // -------------------------------------------------------------------------
  // Ports
  // -------------------------------------------------------------------------

  readonly projects = {
    createProject: (actor: Actor, req: CreateProjectRequest) =>
      this.request<CreateProjectResponse>(actor, "POST", "/api/projects", req),

    getProject: (actor: Actor, projectId: string) =>
      this.request<Project>(actor, "GET", `/api/projects/${enc(projectId)}`),

    renameProject: (actor: Actor, projectId: string, title: string) =>
      this.request<Project>(actor, "PATCH", `/api/projects/${enc(projectId)}`, { title }),

    listTakes: (actor: Actor, projectId: string) =>
      this.request<TakeSummary[]>(actor, "GET", `/api/projects/${enc(projectId)}/takes`),

    getRevision: async (actor: Actor, projectId: string, takeId: string, revision?: number): Promise<Result<Revision>> => {
      let query = "";
      if (revision !== undefined) {
        // Port semantics: a revision that cannot exist is NOT_FOUND.
        if (!Number.isInteger(revision) || revision < 1 || revision > MAX_REVISION)
          return err("NOT_FOUND", `revision ${revision} of ${takeId} not found`);
        query = `?revision=${revision}`;
      }
      return this.request(actor, "GET", `/api/projects/${enc(projectId)}/takes/${enc(takeId)}/revisions${query}`);
    },

    saveRevision: (actor: Actor, req: SaveRevisionRequest) =>
      this.request<SaveRevisionResponse>(
        actor,
        "POST",
        `/api/projects/${enc(String(req?.projectId))}/takes/${enc(String(req?.takeId))}/revisions`,
        req,
      ),

    forkTake: (actor: Actor, req: ForkTakeRequest) =>
      this.request<ForkTakeResponse>(actor, "POST", `/api/projects/${enc(String(req?.projectId))}/takes`, req),
  };

  readonly assets = {
    /** Record metadata for bytes already uploaded (see PlatformBlobStore). */
    putAsset: (actor: Actor, asset: Asset) => this.request<Asset>(actor, "POST", "/api/assets", asset),

    getAsset: async (actor: Actor, projectId: string, assetId: string): Promise<Result<Asset>> => {
      const found = await this.assetDownload(actor, projectId, assetId);
      return found.ok ? ok(found.value.asset) : found;
    },
  };

  readonly ingestion = {
    registerSource: (actor: Actor, reg: SourceRegistration) =>
      this.request<Source>(actor, "POST", "/api/ingest/sources", reg),

    getSource: (actor: Actor, projectId: string, sourceId: string) =>
      this.request<Source>(actor, "GET", `/api/ingest/sources/${enc(sourceId)}?projectId=${enc(projectId)}`),

    ingest: (actor: Actor, envelope: IngestEnvelope) =>
      this.request<IngestResult>(actor, "POST", "/api/ingest", envelope),

    listObservations: (actor: Actor, projectId: string, sourceId: string) =>
      this.request<Observation[]>(
        actor,
        "GET",
        `/api/ingest/sources/${enc(sourceId)}/observations?projectId=${enc(projectId)}`,
      ),

    latestObservation: (actor: Actor, projectId: string, sourceId: string) =>
      this.request<Observation>(actor, "GET", `/api/ingest/sources/${enc(sourceId)}/latest?projectId=${enc(projectId)}`),
  };

  readonly jobs = {
    createJob: (actor: Actor, job: ReconstructionJob) =>
      this.request<ReconstructionJob>(actor, "POST", "/api/jobs", job),

    getJob: (actor: Actor, projectId: string, jobId: string) =>
      this.request<ReconstructionJob>(actor, "GET", `/api/jobs/${enc(jobId)}?projectId=${enc(projectId)}`),

    listJobs: (actor: Actor, projectId: string, observationId: string) =>
      this.request<ReconstructionJob[]>(actor, "GET", `/api/jobs?projectId=${enc(projectId)}&observationId=${enc(observationId)}`),

    transitionJob: (actor: Actor, projectId: string, jobId: string, to: JobState, patch: JobPatch = {}) =>
      this.request<ReconstructionJob>(actor, "POST", `/api/jobs/${enc(jobId)}/transition`, { projectId, to, patch }),
  };
}
