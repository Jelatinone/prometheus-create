/**
 * In-memory reference implementation of every port in lib/contracts/ports.
 *
 * It is the executable reading of the contract semantics: tests and local
 * development use it until the platform lane provides a real backend, and
 * the platform implementation must pass the same conformance suites.
 * Not for production: no persistence, single process.
 */
import {
  Asset,
  CreateProjectRequest,
  ForkTakeRequest,
  IngestEnvelope,
  ReconstructionJob,
  SaveRevisionRequest,
  SourceRegistration,
  canonicalJson,
  checkEnvelopeAgainstSource,
  checkExpectedRevision,
  checkFrameLimits,
  checkFreshness,
  checkSourceLimits,
  classifyFrame,
  cloneJson,
  collectAssetIds,
  err,
  forkManifest,
  hashJson,
  newId,
  ok,
  parseContract,
  transitionJob,
  type Actor,
  type Backend,
  type CreateProjectResponse,
  type ForkTakeResponse,
  type IngestResult,
  type JobState,
  type Observation,
  type Project,
  type Result,
  type Revision,
  type SaveRevisionResponse,
  type Source,
  type TakeManifest,
  type TakeSummary,
} from "../contracts";

interface Idempotent<T> {
  fingerprint: string;
  response: T;
}

interface ProjectState {
  project: Project;
  /** takeId -> revisions (index 0 = revision 1) */
  takes: Map<string, Revision[]>;
  assets: Map<string, Asset>;
  sources: Map<string, Source>;
  /** sourceId -> sequence -> observation */
  observations: Map<string, Map<number, Observation>>;
  latestSequence: Map<string, number>;
  jobs: Map<string, ReconstructionJob>;
}

export interface MemoryBackendOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class MemoryBackend implements Backend {
  private readonly projectsById = new Map<string, ProjectState>();
  private readonly idempotency = new Map<string, Idempotent<unknown>>();
  private readonly now: () => Date;

  constructor(options: MemoryBackendOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private timestamp(): string {
    return this.now().toISOString();
  }

  private access(actor: Actor, projectId: string): Result<ProjectState> {
    if (!actor) return err("UNAUTHORIZED", "sign in required");
    const state = this.projectsById.get(projectId);
    // Another user's project is indistinguishable from a missing one.
    if (!state || state.project.ownerId !== actor.userId)
      return err("NOT_FOUND", `project ${projectId} not found`);
    return ok(state);
  }

  private replay<T>(scope: string, key: string, payload: unknown): Result<T> | null {
    const hit = this.idempotency.get(`${scope}:${key}`);
    if (!hit) return null;
    if (hit.fingerprint !== canonicalJson(payload))
      return err("IDEMPOTENCY_KEY_REUSED", `idempotency key ${key} was used with a different request`);
    return ok(cloneJson(hit.response as T));
  }

  private remember(scope: string, key: string, payload: unknown, response: unknown) {
    this.idempotency.set(`${scope}:${key}`, {
      fingerprint: canonicalJson(payload),
      response: cloneJson(response),
    });
  }

  private checkAssets(state: ProjectState, manifest: TakeManifest): Result<string[]> {
    const ids = collectAssetIds(manifest);
    const missing = ids.filter((id) => !state.assets.has(id));
    if (missing.length)
      return err("INVALID_ASSET_REFERENCE", `manifest references unknown assets`, { missing });
    return ok(ids);
  }

  private async appendRevision(
    state: ProjectState,
    actor: { userId: string },
    manifest: TakeManifest,
    origin: Revision["origin"],
    idempotencyKey: string,
    message: string | null,
  ): Promise<Revision> {
    const takeId = manifest.take.id;
    const revisions = state.takes.get(takeId) ?? [];
    const prev = revisions.at(-1) ?? null;
    const revision: Revision = {
      schemaVersion: 1,
      id: newId("revision"),
      projectId: state.project.id,
      takeId,
      number: revisions.length + 1,
      parentRevisionId: origin === "fork" ? manifest.take.parent?.revisionId ?? null : prev?.id ?? null,
      origin,
      manifest: cloneJson(manifest),
      manifestHash: await hashJson(manifest),
      createdAt: this.timestamp(),
      createdBy: actor.userId,
      idempotencyKey,
      message,
    };
    revisions.push(revision);
    state.takes.set(takeId, revisions);
    state.project.updatedAt = revision.createdAt;
    return revision;
  }

  private static saveResponse(revision: Revision, assetIds: string[]): SaveRevisionResponse {
    return {
      revisionId: revision.id,
      takeId: revision.takeId,
      revision: revision.number,
      savedAt: revision.createdAt,
      manifestHash: revision.manifestHash,
      assetIds,
    };
  }

  // -------------------------------------------------------------------------
  // ProjectRepository
  // -------------------------------------------------------------------------

  readonly projects = {
    createProject: async (actor: Actor, input: CreateProjectRequest): Promise<Result<CreateProjectResponse>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(CreateProjectRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const replayed = this.replay<CreateProjectResponse>(`create:${actor.userId}`, req.idempotencyKey, req);
      if (replayed) return replayed;
      if (this.projectsById.has(req.projectId))
        return err("DUPLICATE", `project ${req.projectId} already exists`);
      const at = this.timestamp();
      const state: ProjectState = {
        project: {
          schemaVersion: 1,
          id: req.projectId,
          ownerId: actor.userId,
          title: req.title,
          activeTakeId: req.initialManifest.take.id,
          createdAt: at,
          updatedAt: at,
        },
        takes: new Map(),
        assets: new Map(),
        sources: new Map(),
        observations: new Map(),
        latestSequence: new Map(),
        jobs: new Map(),
      };
      // A new project has no assets yet, so its initial scene must not
      // reference any (create first, upload, then save revision 2).
      const assets = this.checkAssets(state, req.initialManifest);
      if (!assets.ok) return assets;
      this.projectsById.set(req.projectId, state);
      const revision = await this.appendRevision(state, actor, req.initialManifest, "create", req.idempotencyKey, null);
      const response: CreateProjectResponse = {
        project: cloneJson(state.project),
        revision: MemoryBackend.saveResponse(revision, assets.value),
      };
      this.remember(`create:${actor.userId}`, req.idempotencyKey, req, response);
      return ok(response);
    },

    getProject: async (actor: Actor, projectId: string): Promise<Result<Project>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      return ok(cloneJson(state.value.project));
    },

    listTakes: async (actor: Actor, projectId: string): Promise<Result<TakeSummary[]>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const out: TakeSummary[] = [];
      for (const [takeId, revisions] of state.value.takes) {
        const head = revisions.at(-1)!;
        out.push({
          takeId,
          name: head.manifest.take.name,
          headRevision: head.number,
          headRevisionId: head.id,
          parent: head.manifest.take.parent,
          updatedAt: head.createdAt,
        });
      }
      return ok(cloneJson(out));
    },

    getRevision: async (
      actor: Actor,
      projectId: string,
      takeId: string,
      revision?: number,
    ): Promise<Result<Revision>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const revisions = state.value.takes.get(takeId);
      if (!revisions) return err("NOT_FOUND", `take ${takeId} not found`);
      const found = revision === undefined ? revisions.at(-1) : revisions[revision - 1];
      if (!found) return err("NOT_FOUND", `revision ${revision} of ${takeId} not found`);
      return ok(cloneJson(found));
    },

    saveRevision: async (actor: Actor, input: SaveRevisionRequest): Promise<Result<SaveRevisionResponse>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(SaveRevisionRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const state = this.access(actor, req.projectId);
      if (!state.ok) return state;
      const scope = `save:${req.projectId}:${req.takeId}`;
      const replayed = this.replay<SaveRevisionResponse>(scope, req.idempotencyKey, req);
      if (replayed) return replayed;
      const revisions = state.value.takes.get(req.takeId);
      if (!revisions) return err("NOT_FOUND", `take ${req.takeId} not found`);
      const head = revisions.at(-1)!;
      const cas = checkExpectedRevision(head, req.expectedRevision);
      if (!cas.ok) return cas;
      if (canonicalJson(req.manifest.take.parent) !== canonicalJson(head.manifest.take.parent))
        return err("INVALID_SCHEMA", "a save cannot change take.parent");
      const assets = this.checkAssets(state.value, req.manifest);
      if (!assets.ok) return assets;
      const revision = await this.appendRevision(state.value, actor, req.manifest, "save", req.idempotencyKey, req.message);
      const response = MemoryBackend.saveResponse(revision, assets.value);
      this.remember(scope, req.idempotencyKey, req, response);
      return ok(response);
    },

    forkTake: async (actor: Actor, input: ForkTakeRequest): Promise<Result<ForkTakeResponse>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(ForkTakeRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const state = this.access(actor, req.projectId);
      if (!state.ok) return state;
      const scope = `fork:${req.projectId}`;
      const replayed = this.replay<ForkTakeResponse>(scope, req.idempotencyKey, req);
      if (replayed) return replayed;
      const revisions = state.value.takes.get(req.fromTakeId);
      if (!revisions) return err("NOT_FOUND", `take ${req.fromTakeId} not found`);
      const from = revisions[req.fromRevision - 1];
      if (!from) return err("NOT_FOUND", `revision ${req.fromRevision} of ${req.fromTakeId} not found`);
      if (state.value.takes.has(req.newTakeId)) return err("DUPLICATE", `take ${req.newTakeId} already exists`);
      const manifest = forkManifest(from.manifest, {
        newTakeId: req.newTakeId,
        name: req.name,
        parentRevisionId: from.id,
      });
      const revision = await this.appendRevision(state.value, actor, manifest, "fork", req.idempotencyKey, null);
      const response: ForkTakeResponse = {
        takeId: req.newTakeId,
        revisionId: revision.id,
        revision: 1,
        parent: { takeId: from.takeId, revisionId: from.id },
      };
      this.remember(scope, req.idempotencyKey, req, response);
      return ok(response);
    },
  };

  // -------------------------------------------------------------------------
  // AssetCatalog
  // -------------------------------------------------------------------------

  readonly assets = {
    putAsset: async (actor: Actor, input: Asset): Promise<Result<Asset>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(Asset, input);
      if (!parsed.ok) return parsed;
      const asset = parsed.value;
      const state = this.access(actor, asset.projectId);
      if (!state.ok) return state;
      const existing = state.value.assets.get(asset.id);
      if (existing) {
        if (existing.contentHash !== asset.contentHash)
          return err("DUPLICATE", `asset ${asset.id} already exists with different content`);
        return ok(cloneJson(existing));
      }
      state.value.assets.set(asset.id, cloneJson(asset));
      return ok(cloneJson(asset));
    },

    getAsset: async (actor: Actor, projectId: string, assetId: string): Promise<Result<Asset>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const asset = state.value.assets.get(assetId);
      if (!asset) return err("NOT_FOUND", `asset ${assetId} not found`);
      return ok(cloneJson(asset));
    },
  };

  // -------------------------------------------------------------------------
  // IngestionGateway
  // -------------------------------------------------------------------------

  readonly ingestion = {
    registerSource: async (actor: Actor, input: SourceRegistration): Promise<Result<Source>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(SourceRegistration, input);
      if (!parsed.ok) return parsed;
      const reg = parsed.value;
      const state = this.access(actor, reg.projectId);
      if (!state.ok) return state;
      const existing = state.value.sources.get(reg.id);
      if (existing) {
        const rest: Record<string, unknown> = { ...existing };
        delete rest.createdAt;
        if (canonicalJson(rest) !== canonicalJson(reg))
          return err("DUPLICATE", `source ${reg.id} already registered with different content`);
        return ok(cloneJson(existing));
      }
      let byteSize: number | null = null;
      if (reg.assetId) {
        const asset = state.value.assets.get(reg.assetId);
        if (!asset) return err("MISSING_ASSET", `source asset ${reg.assetId} has not been uploaded`);
        if (asset.contentHash !== reg.contentHash)
          return err("INVALID_SCHEMA", "source contentHash differs from the stored asset");
        byteSize = asset.byteSize;
      }
      const limits = checkSourceLimits(reg, byteSize);
      if (!limits.ok) return limits;
      const source: Source = { ...cloneJson(reg), createdAt: this.timestamp() };
      state.value.sources.set(source.id, source);
      return ok(cloneJson(source));
    },

    getSource: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Source>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const source = state.value.sources.get(sourceId);
      if (!source) return err("NOT_FOUND", `source ${sourceId} not found`);
      return ok(cloneJson(source));
    },

    ingest: async (actor: Actor, input: IngestEnvelope): Promise<Result<IngestResult>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(IngestEnvelope, input);
      if (!parsed.ok) return parsed;
      const envelope = parsed.value;
      const state = this.access(actor, envelope.projectId);
      if (!state.ok) return state;
      const source = state.value.sources.get(envelope.sourceId);
      if (!source) return err("NOT_FOUND", `source ${envelope.sourceId} not found`);
      for (const check of [
        checkFrameLimits(envelope),
        checkEnvelopeAgainstSource(envelope, source),
      ]) {
        if (!check.ok) return check;
      }
      const frameAsset = state.value.assets.get(envelope.frame.assetId);
      if (!frameAsset) return err("MISSING_ASSET", `frame asset ${envelope.frame.assetId} has not been uploaded`);
      if (frameAsset.contentHash !== envelope.frame.contentHash)
        return err("INVALID_SCHEMA", "frame contentHash differs from the stored asset");

      const bySequence = state.value.observations.get(source.id) ?? new Map<number, Observation>();
      const latest = state.value.latestSequence.get(source.id) ?? null;
      const classified = classifyFrame(envelope, bySequence.get(envelope.sequence), latest);
      if (!classified.ok) return classified;
      if (classified.value.kind === "duplicate") {
        return ok({
          status: "duplicate",
          observationId: classified.value.observationId,
          sourceId: source.id,
          sequence: envelope.sequence,
          outOfOrder: bySequence.get(envelope.sequence)!.outOfOrder,
          latestSequence: latest ?? envelope.sequence,
        });
      }
      const receivedAt = this.now();
      const fresh = checkFreshness(envelope, receivedAt);
      if (!fresh.ok) return fresh;

      const observation: Observation = {
        schemaVersion: 1,
        id: newId("observation"),
        projectId: envelope.projectId,
        sourceId: source.id,
        sequence: envelope.sequence,
        sourceTimeUs: envelope.sourceTimeUs,
        frame: cloneJson(envelope.frame),
        maskAssetIds: [],
        objectId: null,
        camera: null,
        quality: { status: "unknown", score: null },
        mode: envelope.mode,
        capturedAt: envelope.capturedAt,
        receivedAt: receivedAt.toISOString(),
        outOfOrder: classified.value.outOfOrder,
      };
      bySequence.set(envelope.sequence, observation);
      state.value.observations.set(source.id, bySequence);
      const nextLatest = latest === null ? envelope.sequence : Math.max(latest, envelope.sequence);
      state.value.latestSequence.set(source.id, nextLatest);
      return ok({
        status: "accepted",
        observationId: observation.id,
        sourceId: source.id,
        sequence: envelope.sequence,
        outOfOrder: observation.outOfOrder,
        latestSequence: nextLatest,
      });
    },

    listObservations: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation[]>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      if (!state.value.sources.has(sourceId)) return err("NOT_FOUND", `source ${sourceId} not found`);
      const list = [...(state.value.observations.get(sourceId)?.values() ?? [])].sort(
        (a, b) => a.sourceTimeUs - b.sourceTimeUs || a.sequence - b.sequence,
      );
      return ok(cloneJson(list));
    },

    latestObservation: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      if (!state.value.sources.has(sourceId)) return err("NOT_FOUND", `source ${sourceId} not found`);
      const latest = state.value.latestSequence.get(sourceId);
      const obs = latest === undefined ? undefined : state.value.observations.get(sourceId)?.get(latest);
      if (!obs) return err("NOT_FOUND", `source ${sourceId} has no observations yet`);
      return ok(cloneJson(obs));
    },
  };

  // -------------------------------------------------------------------------
  // JobStore
  // -------------------------------------------------------------------------

  readonly jobs = {
    createJob: async (actor: Actor, input: ReconstructionJob): Promise<Result<ReconstructionJob>> => {
      if (!actor) return err("UNAUTHORIZED", "sign in required");
      const parsed = parseContract(ReconstructionJob, input);
      if (!parsed.ok) return parsed;
      const job = parsed.value;
      const state = this.access(actor, job.projectId);
      if (!state.ok) return state;
      const existing = state.value.jobs.get(job.id);
      if (existing) {
        if (existing.inputHash !== job.inputHash)
          return err("DUPLICATE", `job ${job.id} already exists with different input`);
        return ok(cloneJson(existing));
      }
      if (job.state !== "queued") return err("INVALID_TRANSITION", "new jobs start in queued");
      state.value.jobs.set(job.id, cloneJson(job));
      return ok(cloneJson(job));
    },

    getJob: async (actor: Actor, projectId: string, jobId: string): Promise<Result<ReconstructionJob>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const job = state.value.jobs.get(jobId);
      if (!job) return err("NOT_FOUND", `job ${jobId} not found`);
      return ok(cloneJson(job));
    },

    listJobs: async (actor: Actor, projectId: string, observationId: string): Promise<Result<ReconstructionJob[]>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const jobs = [...state.value.jobs.values()].filter((j) => j.input.observationId === observationId);
      // Newest first; insertion order breaks ties (the reference clock may not advance between jobs).
      const order = new Map(jobs.map((j, i) => [j.id, i]));
      jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || order.get(b.id)! - order.get(a.id)!);
      return ok(jobs.map((j) => cloneJson(j)));
    },

    transitionJob: async (
      actor: Actor,
      projectId: string,
      jobId: string,
      to: JobState,
      patch: Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">> = {},
    ): Promise<Result<ReconstructionJob>> => {
      const state = this.access(actor, projectId);
      if (!state.ok) return state;
      const job = state.value.jobs.get(jobId);
      if (!job) return err("NOT_FOUND", `job ${jobId} not found`);
      const next = transitionJob(job, to, this.timestamp(), patch);
      if (!next.ok) return next;
      state.value.jobs.set(jobId, cloneJson(next.value));
      return ok(cloneJson(next.value));
    },
  };
}
