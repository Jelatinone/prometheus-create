/**
 * Ports: the operations each lane may depend on, independent of storage.
 *
 * - Platform implements these against TigerData + Supabase Storage.
 * - lib/reference/memory-backend.ts is the in-memory reference used by
 *   tests and local development before the platform lands.
 * - tests/conformance/* is the executable definition of the semantics; every
 *   implementation must pass the same suite.
 *
 * Every method returns Result<T>; nothing throws for an expected failure.
 */
import type { Asset } from "./asset";
import type { Result } from "./common";
import type { IngestEnvelope, IngestResult, JobState, ReconstructionJob } from "./ingestion";
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  ForkTakeRequest,
  ForkTakeResponse,
  Revision,
  SaveRevisionRequest,
  SaveRevisionResponse,
  TakeSummary,
} from "./revision";
import type { Project } from "./scene";
import type { Observation, Source, SourceRegistration } from "./source";

/**
 * The authenticated caller. null = unauthenticated (UNAUTHORIZED).
 * Authenticated access to another user's project is NOT_FOUND.
 */
export type Actor = { userId: string } | null;

export interface ProjectRepository {
  createProject(actor: Actor, req: CreateProjectRequest): Promise<Result<CreateProjectResponse>>;
  getProject(actor: Actor, projectId: string): Promise<Result<Project>>;
  /** Owner only; the title is trimmed (1-120 characters). */
  renameProject(actor: Actor, projectId: string, title: string): Promise<Result<Project>>;
  listTakes(actor: Actor, projectId: string): Promise<Result<TakeSummary[]>>;
  /** A specific revision number, or the head when `revision` is omitted. */
  getRevision(
    actor: Actor,
    projectId: string,
    takeId: string,
    revision?: number,
  ): Promise<Result<Revision>>;
  saveRevision(actor: Actor, req: SaveRevisionRequest): Promise<Result<SaveRevisionResponse>>;
  forkTake(actor: Actor, req: ForkTakeRequest): Promise<Result<ForkTakeResponse>>;
}

export interface AssetCatalog {
  /** Record an uploaded asset. Idempotent on (id, contentHash). */
  putAsset(actor: Actor, asset: Asset): Promise<Result<Asset>>;
  getAsset(actor: Actor, projectId: string, assetId: string): Promise<Result<Asset>>;
}

export interface IngestionGateway {
  /** Idempotent on (id, identical content); conflicting reuse is DUPLICATE. */
  registerSource(actor: Actor, reg: SourceRegistration): Promise<Result<Source>>;
  getSource(actor: Actor, projectId: string, sourceId: string): Promise<Result<Source>>;
  ingest(actor: Actor, envelope: IngestEnvelope): Promise<Result<IngestResult>>;
  /** Ordered by sourceTimeUs, then sequence. */
  listObservations(actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation[]>>;
  /** Highest accepted sequence; NOT_FOUND when the source has none. */
  latestObservation(actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation>>;
}

export interface JobStore {
  /** Idempotent on job id; a new job must start in "queued". */
  createJob(actor: Actor, job: ReconstructionJob): Promise<Result<ReconstructionJob>>;
  getJob(actor: Actor, projectId: string, jobId: string): Promise<Result<ReconstructionJob>>;
  /** Every job whose input names this observation, newest first (so earlier results can be reused, not paid for again). */
  listJobs(actor: Actor, projectId: string, observationId: string): Promise<Result<ReconstructionJob[]>>;
  transitionJob(
    actor: Actor,
    projectId: string,
    jobId: string,
    to: JobState,
    patch?: Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">>,
  ): Promise<Result<ReconstructionJob>>;
}

/** Everything the platform lane provides behind one backend. */
export interface Backend {
  projects: ProjectRepository;
  assets: AssetCatalog;
  ingestion: IngestionGateway;
  jobs: JobStore;
}
