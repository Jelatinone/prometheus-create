/**
 * PostgresBackend: every port in lib/contracts/ports, backed by TigerData.
 *
 * Semantics follow lib/reference/memory-backend.ts and are proven by
 * tests/conformance/backend-conformance.ts (tests/platform runs it against a
 * dedicated test database). Differences are storage mechanics only:
 *
 * - Ownership is relational: every query joins projects and compares
 *   owner_id with the actor. Another user's project is NOT_FOUND.
 * - saveRevision locks the take row (SELECT ... FOR UPDATE), checks
 *   expectedRevision against the head, appends the revision and moves the
 *   head in one transaction. A UNIQUE (project_id, take_id, number)
 *   constraint backs the compare-and-swap.
 * - Idempotent commands (create, save, fork) record their response in
 *   idempotency_keys inside the same transaction; create and fork take a
 *   transaction-scoped advisory lock on the key, saves are serialized by the
 *   take lock.
 * - ingest locks the source row, so new/duplicate/out-of-order
 *   classification is serialized per source.
 *
 * Expected failures are Result values; driver/network failures throw.
 */
import {
  Asset,
  CreateProjectRequest,
  RenameProjectRequest,
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
  collectAssetIds,
  err,
  forkManifest,
  hashJson,
  newId,
  ok,
  parseContract,
  sha256,
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
} from "@/lib/contracts";
import { UNIQUE_VIOLATION, sqlState, withTransaction, type Pool, type PoolClient } from "./db";

type Signed = { userId: string };
type Queryable = Pool | PoolClient;
type JobPatch = Partial<Pick<ReconstructionJob, "providerRequestId" | "output" | "error">>;

interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  active_take_id: string;
  created_at: Date;
  updated_at: Date;
}

interface RevisionRow {
  id: string;
  project_id: string;
  take_id: string;
  number: number;
  parent_revision_id: string | null;
  origin: Revision["origin"];
  manifest: TakeManifest;
  manifest_hash: string;
  created_at: Date;
  created_by: string;
  idempotency_key: string;
  message: string | null;
}

interface IdempotencyColumns {
  fingerprint: string | null;
  response: unknown;
}

export interface PostgresBackendOptions {
  pool: Pool;
  /** Injectable clock (defaults to the system clock). */
  now?: () => Date;
}

const REVISION_COLUMNS =
  "r.id, r.project_id, r.take_id, r.number, r.parent_revision_id, r.origin, r.manifest, r.manifest_hash, r.created_at, r.created_by, r.idempotency_key, r.message";

const MAX_INT4 = 2_147_483_647;

const unauthorized = <T>(): Result<T> => err("UNAUTHORIZED", "sign in required");
const projectNotFound = <T>(projectId: string): Result<T> => err("NOT_FOUND", `project ${projectId} not found`);
const owns = (actor: Signed, ownerId: string | null | undefined) => ownerId === actor.userId;

function toProject(row: ProjectRow): Project {
  return {
    schemaVersion: 1,
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    activeTakeId: row.active_take_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRevision(row: RevisionRow): Revision {
  return {
    schemaVersion: 1,
    id: row.id,
    projectId: row.project_id,
    takeId: row.take_id,
    number: row.number,
    parentRevisionId: row.parent_revision_id,
    origin: row.origin,
    manifest: row.manifest,
    manifestHash: row.manifest_hash,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    idempotencyKey: row.idempotency_key,
    message: row.message,
  };
}

/** sha256 of the canonical request: what an idempotency key is bound to. */
function fingerprint(request: unknown): Promise<string> {
  return sha256(canonicalJson(request));
}

/** Replay a stored response, or reject a key reused with a different request. */
function replay<T>(row: IdempotencyColumns, fp: string, key: string): Result<T> | null {
  if (row.fingerprint === null) return null;
  if (row.fingerprint !== fp)
    return err("IDEMPOTENCY_KEY_REUSED", `idempotency key ${key} was used with a different request`);
  return ok(row.response as T);
}

/** Transaction-scoped lock serializing requests that share an idempotency key. */
async function lockKey(client: PoolClient, scope: string, key: string) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope}:${key}`]);
}

const json = (value: unknown) => JSON.stringify(value);

export class PostgresBackend implements Backend {
  readonly pool: Pool;
  private readonly now: () => Date;

  constructor(options: PostgresBackendOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** NOT_FOUND that never reveals whether another user's project exists. */
  private async missing<T>(q: Queryable, actor: Signed, projectId: string, message: string): Promise<Result<T>> {
    const { rows } = await q.query<{ owner_id: string }>("select owner_id from projects where id = $1", [projectId]);
    if (!owns(actor, rows[0]?.owner_id)) return projectNotFound(projectId);
    return err("NOT_FOUND", message);
  }

  // -------------------------------------------------------------------------
  // Platform extras (not part of the ports)
  // -------------------------------------------------------------------------

  /** The actor's projects, most recently updated first. */
  async listProjects(actor: Actor): Promise<Result<Project[]>> {
    if (!actor) return unauthorized();
    const { rows } = await this.pool.query<ProjectRow>(
      "select * from projects where owner_id = $1 order by updated_at desc, id limit 200",
      [actor.userId],
    );
    return ok(rows.map(toProject));
  }

  // -------------------------------------------------------------------------
  // ProjectRepository (CT-003)
  // -------------------------------------------------------------------------

  readonly projects = {
    createProject: async (actor: Actor, input: CreateProjectRequest): Promise<Result<CreateProjectResponse>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(CreateProjectRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const scope = `create:${actor.userId}`;
      const fp = await fingerprint(req);
      const manifestHash = await hashJson(req.initialManifest);
      // A new project has no assets yet, so its initial scene must not
      // reference any (create first, upload, then save revision 2).
      const referenced = collectAssetIds(req.initialManifest);

      return withTransaction(this.pool, async (c) => {
        await lockKey(c, scope, req.idempotencyKey);
        const { rows } = await c.query<IdempotencyColumns & { project_exists: boolean }>(
          `select
             (select fingerprint from idempotency_keys where scope = $1 and key = $2) as fingerprint,
             (select response from idempotency_keys where scope = $1 and key = $2) as response,
             exists (select 1 from projects where id = $3) as project_exists`,
          [scope, req.idempotencyKey, req.projectId],
        );
        const state = rows[0];
        const replayed = replay<CreateProjectResponse>(state, fp, req.idempotencyKey);
        if (replayed) return replayed;
        if (state.project_exists) return err("DUPLICATE", `project ${req.projectId} already exists`);
        if (referenced.length)
          return err("INVALID_ASSET_REFERENCE", "manifest references unknown assets", { missing: referenced });

        const at = this.timestamp();
        const takeId = req.initialManifest.take.id;
        const revisionId = newId("revision");
        const response: CreateProjectResponse = {
          project: {
            schemaVersion: 1,
            id: req.projectId,
            ownerId: actor.userId,
            title: req.title,
            activeTakeId: takeId,
            createdAt: at,
            updatedAt: at,
          },
          revision: { revisionId, takeId, revision: 1, savedAt: at, manifestHash, assetIds: [] },
        };
        try {
          await c.query(
            `with p as (
               insert into projects (id, owner_id, title, active_take_id, created_at, updated_at)
               values ($1, $2, $3, $4, $5, $5)
             ), t as (
               insert into takes (project_id, id, name, head_revision, head_revision_id, created_at, updated_at)
               values ($1, $4, $6, 1, $7, $5, $5)
             ), r as (
               insert into revisions (id, project_id, take_id, number, parent_revision_id, origin, manifest,
                                      manifest_hash, created_at, created_by, idempotency_key, message)
               values ($7, $1, $4, 1, null, 'create', $8::jsonb, $9, $5, $2, $10, null)
             )
             insert into idempotency_keys (scope, key, fingerprint, response) values ($11, $10, $12, $13::jsonb)`,
            [
              req.projectId,
              actor.userId,
              req.title,
              takeId,
              at,
              req.initialManifest.take.name,
              revisionId,
              json(req.initialManifest),
              manifestHash,
              req.idempotencyKey,
              scope,
              fp,
              json(response),
            ],
          );
        } catch (error) {
          if (sqlState(error) === UNIQUE_VIOLATION) return err("DUPLICATE", `project ${req.projectId} already exists`);
          throw error;
        }
        return ok(response);
      });
    },

    getProject: async (actor: Actor, projectId: string): Promise<Result<Project>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<ProjectRow>("select * from projects where id = $1", [projectId]);
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      return ok(toProject(rows[0]));
    },

    renameProject: async (actor: Actor, projectId: string, title: string): Promise<Result<Project>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(RenameProjectRequest, { title });
      if (!parsed.ok) return parsed;
      const { rows } = await this.pool.query<ProjectRow>(
        "update projects set title = $3, updated_at = now() where id = $1 and owner_id = $2 returning *",
        [projectId, actor.userId, parsed.value.title],
      );
      if (!rows.length) return projectNotFound(projectId);
      return ok(toProject(rows[0]));
    },

    listTakes: async (actor: Actor, projectId: string): Promise<Result<TakeSummary[]>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{
        owner_id: string;
        id: string | null;
        name: string;
        head_revision: number;
        head_revision_id: string;
        parent_take_id: string | null;
        parent_revision_id: string | null;
        updated_at: Date;
      }>(
        `select p.owner_id, t.id, t.name, t.head_revision, t.head_revision_id, t.parent_take_id,
                t.parent_revision_id, t.updated_at
           from projects p left join takes t on t.project_id = p.id
          where p.id = $1
          order by t.created_at, t.id`,
        [projectId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      return ok(
        rows
          .filter((r) => r.id !== null)
          .map((r) => ({
            takeId: r.id!,
            name: r.name,
            headRevision: r.head_revision,
            headRevisionId: r.head_revision_id,
            parent:
              r.parent_take_id && r.parent_revision_id
                ? { takeId: r.parent_take_id, revisionId: r.parent_revision_id }
                : null,
            updatedAt: r.updated_at.toISOString(),
          })),
      );
    },

    getRevision: async (
      actor: Actor,
      projectId: string,
      takeId: string,
      revision?: number,
    ): Promise<Result<Revision>> => {
      if (!actor) return unauthorized();
      const wanted = revision === undefined ? null : revision;
      const valid = wanted === null || (Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_INT4);
      const { rows } = await this.pool.query<RevisionRow & { owner_id: string; take_exists: boolean }>(
        `select p.owner_id, (t.id is not null) as take_exists, ${REVISION_COLUMNS}
           from projects p
           left join takes t on t.project_id = p.id and t.id = $2
           left join revisions r on r.project_id = p.id and r.take_id = t.id
                                and r.number = coalesce($3::int, t.head_revision)
          where p.id = $1`,
        [projectId, takeId, valid ? wanted : null],
      );
      const row = rows[0];
      if (!row || !owns(actor, row.owner_id)) return projectNotFound(projectId);
      if (!row.take_exists) return err("NOT_FOUND", `take ${takeId} not found`);
      if (!valid || row.id === null) return err("NOT_FOUND", `revision ${revision} of ${takeId} not found`);
      return ok(toRevision(row));
    },

    saveRevision: async (actor: Actor, input: SaveRevisionRequest): Promise<Result<SaveRevisionResponse>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(SaveRevisionRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const scope = `save:${req.projectId}:${req.takeId}`;
      const fp = await fingerprint(req);
      const manifestHash = await hashJson(req.manifest);
      const referenced = collectAssetIds(req.manifest);

      return withTransaction(this.pool, async (c) => {
        // Lock the head pointer: concurrent saves of this take queue here.
        const { rows } = await c.query<
          IdempotencyColumns & {
            head_revision: number;
            head_revision_id: string;
            parent_take_id: string | null;
            parent_revision_id: string | null;
            found_assets: string[];
          }
        >(
          `select t.head_revision, t.head_revision_id, t.parent_take_id, t.parent_revision_id,
                  (select fingerprint from idempotency_keys where scope = $3 and key = $4) as fingerprint,
                  (select response from idempotency_keys where scope = $3 and key = $4) as response,
                  (select coalesce(array_agg(a.id), '{}') from assets a
                    where a.project_id = $1 and a.id = any($6::text[])) as found_assets
             from takes t join projects p on p.id = t.project_id
            where t.project_id = $1 and t.id = $2 and p.owner_id = $5
            for update of t`,
          [req.projectId, req.takeId, scope, req.idempotencyKey, actor.userId, referenced],
        );
        if (!rows.length) return this.missing(c, actor, req.projectId, `take ${req.takeId} not found`);
        const head = rows[0];
        const replayed = replay<SaveRevisionResponse>(head, fp, req.idempotencyKey);
        if (replayed) return replayed;
        const cas = checkExpectedRevision({ number: head.head_revision, id: head.head_revision_id }, req.expectedRevision);
        if (!cas.ok) return cas;
        const headParent =
          head.parent_take_id && head.parent_revision_id
            ? { takeId: head.parent_take_id, revisionId: head.parent_revision_id }
            : null;
        if (canonicalJson(req.manifest.take.parent) !== canonicalJson(headParent))
          return err("INVALID_SCHEMA", "a save cannot change take.parent");
        const found = new Set(head.found_assets);
        const missing = referenced.filter((id) => !found.has(id));
        if (missing.length) return err("INVALID_ASSET_REFERENCE", "manifest references unknown assets", { missing });

        const at = this.timestamp();
        const revisionId = newId("revision");
        const number = head.head_revision + 1;
        const response: SaveRevisionResponse = {
          revisionId,
          takeId: req.takeId,
          revision: number,
          savedAt: at,
          manifestHash,
          assetIds: referenced,
        };
        await c.query(
          `with r as (
             insert into revisions (id, project_id, take_id, number, parent_revision_id, origin, manifest,
                                    manifest_hash, created_at, created_by, idempotency_key, message)
             values ($1, $2, $3, $4, $5, 'save', $6::jsonb, $7, $8, $9, $10, $11)
           ), t as (
             update takes set head_revision = $4, head_revision_id = $1, name = $12, updated_at = $8
              where project_id = $2 and id = $3
           ), p as (
             update projects set updated_at = $8 where id = $2
           )
           insert into idempotency_keys (scope, key, fingerprint, response) values ($13, $10, $14, $15::jsonb)`,
          [
            revisionId,
            req.projectId,
            req.takeId,
            number,
            head.head_revision_id,
            json(req.manifest),
            manifestHash,
            at,
            actor.userId,
            req.idempotencyKey,
            req.message,
            req.manifest.take.name,
            scope,
            fp,
            json(response),
          ],
        );
        return ok(response);
      });
    },

    forkTake: async (actor: Actor, input: ForkTakeRequest): Promise<Result<ForkTakeResponse>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(ForkTakeRequest, input);
      if (!parsed.ok) return parsed;
      const req = parsed.value;
      const scope = `fork:${req.projectId}`;
      const fp = await fingerprint(req);

      return withTransaction(this.pool, async (c) => {
        await lockKey(c, scope, req.idempotencyKey);
        const { rows } = await c.query<
          IdempotencyColumns & {
            owner_id: string;
            from_take_exists: boolean;
            from_revision: { id: string; take_id: string; manifest: TakeManifest } | null;
            new_take_exists: boolean;
          }
        >(
          `select p.owner_id,
                  (select fingerprint from idempotency_keys where scope = $2 and key = $3) as fingerprint,
                  (select response from idempotency_keys where scope = $2 and key = $3) as response,
                  exists (select 1 from takes where project_id = $1 and id = $4) as from_take_exists,
                  (select row_to_json(x) from (
                     select id, take_id, manifest from revisions
                      where project_id = $1 and take_id = $4 and number = $5
                   ) x) as from_revision,
                  exists (select 1 from takes where project_id = $1 and id = $6) as new_take_exists
             from projects p where p.id = $1`,
          [req.projectId, scope, req.idempotencyKey, req.fromTakeId, req.fromRevision, req.newTakeId],
        );
        const state = rows[0];
        if (!state || !owns(actor, state.owner_id)) return projectNotFound(req.projectId);
        const replayed = replay<ForkTakeResponse>(state, fp, req.idempotencyKey);
        if (replayed) return replayed;
        if (!state.from_take_exists) return err("NOT_FOUND", `take ${req.fromTakeId} not found`);
        const from = state.from_revision;
        if (!from) return err("NOT_FOUND", `revision ${req.fromRevision} of ${req.fromTakeId} not found`);
        if (state.new_take_exists) return err("DUPLICATE", `take ${req.newTakeId} already exists`);

        const manifest = forkManifest(from.manifest, {
          newTakeId: req.newTakeId,
          name: req.name,
          parentRevisionId: from.id,
        });
        const manifestHash = await hashJson(manifest);
        const at = this.timestamp();
        const revisionId = newId("revision");
        const response: ForkTakeResponse = {
          takeId: req.newTakeId,
          revisionId,
          revision: 1,
          parent: { takeId: from.take_id, revisionId: from.id },
        };
        try {
          await c.query(
            `with t as (
               insert into takes (project_id, id, name, parent_take_id, parent_revision_id, head_revision,
                                  head_revision_id, created_at, updated_at)
               values ($1, $2, $3, $4, $5, 1, $6, $7, $7)
             ), r as (
               insert into revisions (id, project_id, take_id, number, parent_revision_id, origin, manifest,
                                      manifest_hash, created_at, created_by, idempotency_key, message)
               values ($6, $1, $2, 1, $5, 'fork', $8::jsonb, $9, $7, $10, $11, null)
             ), p as (
               update projects set updated_at = $7 where id = $1
             )
             insert into idempotency_keys (scope, key, fingerprint, response) values ($12, $11, $13, $14::jsonb)`,
            [
              req.projectId,
              req.newTakeId,
              req.name,
              from.take_id,
              from.id,
              revisionId,
              at,
              json(manifest),
              manifestHash,
              actor.userId,
              req.idempotencyKey,
              scope,
              fp,
              json(response),
            ],
          );
        } catch (error) {
          if (sqlState(error) === UNIQUE_VIOLATION) return err("DUPLICATE", `take ${req.newTakeId} already exists`);
          throw error;
        }
        return ok(response);
      });
    },
  };

  // -------------------------------------------------------------------------
  // AssetCatalog
  // -------------------------------------------------------------------------

  readonly assets = {
    putAsset: async (actor: Actor, input: Asset): Promise<Result<Asset>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(Asset, input);
      if (!parsed.ok) return parsed;
      const asset = parsed.value;
      const { rows } = await this.pool.query<{ owner_id: string | null; inserted: Asset | null; existing: Asset | null }>(
        `with p as (select owner_id from projects where id = $1),
         ins as (
           insert into assets (project_id, id, kind, mime_type, byte_size, content_hash, storage_key, origin, created_at, doc)
           select $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9::timestamptz, $10::jsonb
            where exists (select 1 from p where owner_id = $11)
           on conflict (project_id, id) do nothing
           returning doc
         )
         select (select owner_id from p) as owner_id,
                (select doc from ins) as inserted,
                (select doc from assets where project_id = $1 and id = $2) as existing`,
        [
          asset.projectId,
          asset.id,
          asset.kind,
          asset.mimeType,
          asset.byteSize,
          asset.contentHash,
          asset.storageKey,
          asset.origin,
          asset.createdAt,
          json(asset),
          actor.userId,
        ],
      );
      const row = rows[0];
      if (!owns(actor, row.owner_id)) return projectNotFound(asset.projectId);
      if (row.inserted) return ok(row.inserted);
      // Lost an insert race or the asset already existed: compare with the stored row.
      const existing =
        row.existing ??
        (
          await this.pool.query<{ doc: Asset }>("select doc from assets where project_id = $1 and id = $2", [
            asset.projectId,
            asset.id,
          ])
        ).rows[0]?.doc;
      if (!existing) throw new Error(`asset ${asset.id} conflicted but could not be read back`);
      if (existing.contentHash !== asset.contentHash)
        return err("DUPLICATE", `asset ${asset.id} already exists with different content`);
      return ok(existing);
    },

    getAsset: async (actor: Actor, projectId: string, assetId: string): Promise<Result<Asset>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; doc: Asset | null }>(
        `select p.owner_id, a.doc from projects p
           left join assets a on a.project_id = p.id and a.id = $2
          where p.id = $1`,
        [projectId, assetId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      if (!rows[0].doc) return err("NOT_FOUND", `asset ${assetId} not found`);
      return ok(rows[0].doc);
    },
  };

  // -------------------------------------------------------------------------
  // IngestionGateway (CT-002)
  // -------------------------------------------------------------------------

  readonly ingestion = {
    registerSource: async (actor: Actor, input: SourceRegistration): Promise<Result<Source>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(SourceRegistration, input);
      if (!parsed.ok) return parsed;
      const reg = parsed.value;
      const { rows } = await this.pool.query<{
        owner_id: string;
        existing: Source | null;
        asset: { contentHash: string; byteSize: number } | null;
      }>(
        `select p.owner_id,
                (select doc from sources where project_id = $1 and id = $2) as existing,
                (select json_build_object('contentHash', content_hash, 'byteSize', byte_size)
                   from assets where project_id = $1 and id = $3) as asset
           from projects p where p.id = $1`,
        [reg.projectId, reg.id, reg.assetId],
      );
      const row = rows[0];
      if (!row || !owns(actor, row.owner_id)) return projectNotFound(reg.projectId);
      if (row.existing) return sameSource(row.existing, reg);

      let byteSize: number | null = null;
      if (reg.assetId) {
        if (!row.asset) return err("MISSING_ASSET", `source asset ${reg.assetId} has not been uploaded`);
        if (row.asset.contentHash !== reg.contentHash)
          return err("INVALID_SCHEMA", "source contentHash differs from the stored asset");
        byteSize = Number(row.asset.byteSize);
      }
      const limits = checkSourceLimits(reg, byteSize);
      if (!limits.ok) return limits;

      const source: Source = { ...reg, createdAt: this.timestamp() };
      const inserted = await this.pool.query<{ doc: Source }>(
        `insert into sources (project_id, id, adapter, media_kind, asset_id, content_hash, capture_session_id, created_at, doc)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (project_id, id) do nothing
         returning doc`,
        [
          source.projectId,
          source.id,
          source.adapter,
          source.media.kind,
          source.assetId,
          source.contentHash,
          source.captureSessionId,
          source.createdAt,
          json(source),
        ],
      );
      if (inserted.rows.length) return ok(inserted.rows[0].doc);
      const raced = await this.pool.query<{ doc: Source }>("select doc from sources where project_id = $1 and id = $2", [
        reg.projectId,
        reg.id,
      ]);
      return sameSource(raced.rows[0].doc, reg);
    },

    getSource: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Source>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; doc: Source | null }>(
        `select p.owner_id, s.doc from projects p
           left join sources s on s.project_id = p.id and s.id = $2
          where p.id = $1`,
        [projectId, sourceId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      if (!rows[0].doc) return err("NOT_FOUND", `source ${sourceId} not found`);
      return ok(rows[0].doc);
    },

    ingest: async (actor: Actor, input: IngestEnvelope): Promise<Result<IngestResult>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(IngestEnvelope, input);
      if (!parsed.ok) return parsed;
      const envelope = parsed.value;

      return withTransaction(this.pool, async (c) => {
        const { rows } = await c.query<{
          source: Source;
          existing: Observation | null;
          latest: string | null;
          frame_hash: string | null;
        }>(
          `select s.doc as source,
                  (select doc from observations
                    where project_id = $1 and source_id = $2 and sequence = $3) as existing,
                  (select max(sequence) from observations where project_id = $1 and source_id = $2) as latest,
                  (select content_hash from assets where project_id = $1 and id = $4) as frame_hash
             from sources s join projects p on p.id = s.project_id
            where s.project_id = $1 and s.id = $2 and p.owner_id = $5
            for update of s`,
          [envelope.projectId, envelope.sourceId, envelope.sequence, envelope.frame.assetId, actor.userId],
        );
        if (!rows.length) return this.missing(c, actor, envelope.projectId, `source ${envelope.sourceId} not found`);
        const row = rows[0];
        for (const check of [checkFrameLimits(envelope), checkEnvelopeAgainstSource(envelope, row.source)]) {
          if (!check.ok) return check;
        }
        if (row.frame_hash === null)
          return err("MISSING_ASSET", `frame asset ${envelope.frame.assetId} has not been uploaded`);
        if (row.frame_hash !== envelope.frame.contentHash)
          return err("INVALID_SCHEMA", "frame contentHash differs from the stored asset");

        const latest = row.latest === null ? null : Number(row.latest);
        const classified = classifyFrame(envelope, row.existing ?? undefined, latest);
        if (!classified.ok) return classified;
        if (classified.value.kind === "duplicate") {
          return ok({
            status: "duplicate",
            observationId: classified.value.observationId,
            sourceId: envelope.sourceId,
            sequence: envelope.sequence,
            outOfOrder: row.existing!.outOfOrder,
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
          sourceId: envelope.sourceId,
          sequence: envelope.sequence,
          sourceTimeUs: envelope.sourceTimeUs,
          frame: envelope.frame,
          maskAssetIds: [],
          objectId: null,
          camera: null,
          quality: { status: "unknown", score: null },
          mode: envelope.mode,
          capturedAt: envelope.capturedAt,
          receivedAt: receivedAt.toISOString(),
          outOfOrder: classified.value.outOfOrder,
        };
        await c.query(
          `insert into observations (project_id, id, source_id, sequence, source_time_us, frame_asset_id,
                                     frame_content_hash, mode, out_of_order, received_at, doc)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [
            observation.projectId,
            observation.id,
            observation.sourceId,
            observation.sequence,
            observation.sourceTimeUs,
            observation.frame.assetId,
            observation.frame.contentHash,
            observation.mode,
            observation.outOfOrder,
            observation.receivedAt,
            json(observation),
          ],
        );
        const latestSequence = latest === null ? envelope.sequence : Math.max(latest, envelope.sequence);
        return ok({
          status: "accepted",
          observationId: observation.id,
          sourceId: envelope.sourceId,
          sequence: envelope.sequence,
          outOfOrder: observation.outOfOrder,
          latestSequence,
        });
      });
    },

    listObservations: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation[]>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; source_exists: boolean; docs: Observation[] }>(
        `select p.owner_id,
                exists (select 1 from sources where project_id = $1 and id = $2) as source_exists,
                coalesce((select json_agg(doc order by source_time_us, sequence) from observations
                           where project_id = $1 and source_id = $2), '[]'::json) as docs
           from projects p where p.id = $1`,
        [projectId, sourceId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      if (!rows[0].source_exists) return err("NOT_FOUND", `source ${sourceId} not found`);
      return ok(rows[0].docs);
    },

    latestObservation: async (actor: Actor, projectId: string, sourceId: string): Promise<Result<Observation>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; source_exists: boolean; doc: Observation | null }>(
        `select p.owner_id,
                exists (select 1 from sources where project_id = $1 and id = $2) as source_exists,
                (select doc from observations where project_id = $1 and source_id = $2
                  order by sequence desc limit 1) as doc
           from projects p where p.id = $1`,
        [projectId, sourceId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      if (!rows[0].source_exists) return err("NOT_FOUND", `source ${sourceId} not found`);
      if (!rows[0].doc) return err("NOT_FOUND", `source ${sourceId} has no observations yet`);
      return ok(rows[0].doc);
    },
  };

  // -------------------------------------------------------------------------
  // JobStore (CT-002)
  // -------------------------------------------------------------------------

  readonly jobs = {
    createJob: async (actor: Actor, input: ReconstructionJob): Promise<Result<ReconstructionJob>> => {
      if (!actor) return unauthorized();
      const parsed = parseContract(ReconstructionJob, input);
      if (!parsed.ok) return parsed;
      const job = parsed.value;
      const readBack = async () =>
        (await this.pool.query<{ doc: ReconstructionJob }>("select doc from jobs where project_id = $1 and id = $2", [
          job.projectId,
          job.id,
        ])).rows[0]?.doc ?? null;

      const { rows } = await this.pool.query<{
        owner_id: string | null;
        inserted: ReconstructionJob | null;
        existing: ReconstructionJob | null;
      }>(
        `with p as (select owner_id from projects where id = $1),
         ins as (
           insert into jobs (project_id, id, kind, state, provider, provider_model, provider_request_id,
                             input_hash, created_at, updated_at, doc)
           select $1, $2, $3, $4::text, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb
            where $4::text = 'queued' and exists (select 1 from p where owner_id = $12)
           on conflict (project_id, id) do nothing
           returning doc
         )
         select (select owner_id from p) as owner_id,
                (select doc from ins) as inserted,
                (select doc from jobs where project_id = $1 and id = $2) as existing`,
        [
          job.projectId,
          job.id,
          job.kind,
          job.state,
          job.provider,
          job.providerModel,
          job.providerRequestId,
          job.inputHash,
          job.createdAt,
          job.updatedAt,
          json(job),
          actor.userId,
        ],
      );
      const row = rows[0];
      if (!owns(actor, row.owner_id)) return projectNotFound(job.projectId);
      const sameJob = (existing: ReconstructionJob): Result<ReconstructionJob> =>
        existing.inputHash !== job.inputHash
          ? err("DUPLICATE", `job ${job.id} already exists with different input`)
          : ok(existing);
      if (row.existing) return sameJob(row.existing);
      if (row.inserted) return ok(row.inserted);
      if (job.state !== "queued") return err("INVALID_TRANSITION", "new jobs start in queued");
      const raced = await readBack();
      if (!raced) throw new Error(`job ${job.id} conflicted but could not be read back`);
      return sameJob(raced);
    },

    getJob: async (actor: Actor, projectId: string, jobId: string): Promise<Result<ReconstructionJob>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; doc: ReconstructionJob | null }>(
        `select p.owner_id, j.doc from projects p
           left join jobs j on j.project_id = p.id and j.id = $2
          where p.id = $1`,
        [projectId, jobId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      if (!rows[0].doc) return err("NOT_FOUND", `job ${jobId} not found`);
      return ok(rows[0].doc);
    },

    listJobs: async (actor: Actor, projectId: string, observationId: string): Promise<Result<ReconstructionJob[]>> => {
      if (!actor) return unauthorized();
      const { rows } = await this.pool.query<{ owner_id: string; doc: ReconstructionJob | null }>(
        `select p.owner_id, j.doc from projects p
           left join jobs j on j.project_id = p.id and j.doc->'input'->>'observationId' = $2
          where p.id = $1
          order by j.created_at desc nulls last, j.id desc
          limit 200`,
        [projectId, observationId],
      );
      if (!rows.length || !owns(actor, rows[0].owner_id)) return projectNotFound(projectId);
      return ok(rows.flatMap((r) => (r.doc ? [r.doc] : [])));
    },

    transitionJob: async (
      actor: Actor,
      projectId: string,
      jobId: string,
      to: JobState,
      patch: JobPatch = {},
    ): Promise<Result<ReconstructionJob>> => {
      if (!actor) return unauthorized();
      return withTransaction(this.pool, async (c) => {
        const { rows } = await c.query<{ doc: ReconstructionJob }>(
          `select j.doc from jobs j join projects p on p.id = j.project_id
            where j.project_id = $1 and j.id = $2 and p.owner_id = $3
            for update of j`,
          [projectId, jobId, actor.userId],
        );
        if (!rows.length) return this.missing(c, actor, projectId, `job ${jobId} not found`);
        const next = transitionJob(rows[0].doc, to, this.timestamp(), patch);
        if (!next.ok) return next;
        await c.query(
          `update jobs set state = $3, provider_request_id = $4, updated_at = $5, doc = $6::jsonb
            where project_id = $1 and id = $2`,
          [projectId, jobId, next.value.state, next.value.providerRequestId, next.value.updatedAt, json(next.value)],
        );
        return ok(next.value);
      });
    },
  };
}

/** Same source ID: identical registration replays, anything else is DUPLICATE. */
function sameSource(existing: Source, reg: SourceRegistration): Result<Source> {
  const rest: Record<string, unknown> = { ...existing };
  delete rest.createdAt;
  if (canonicalJson(rest) !== canonicalJson(reg))
    return err("DUPLICATE", `source ${reg.id} already registered with different content`);
  return ok(existing);
}
