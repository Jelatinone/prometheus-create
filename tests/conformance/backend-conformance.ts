/**
 * Executable definition of the Backend port semantics (CT-002, CT-003).
 *
 * Every Backend implementation must pass this suite unchanged:
 *   - the in-memory reference (tests/conformance/memory-backend.test.ts)
 *   - the platform lane's TigerData/Supabase backend (add its own *.test.ts
 *     that calls describeBackendConformance with a harness factory)
 *
 * Tests use fresh random IDs, so the suite can run against a shared test
 * database without cleanup collisions.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  newId,
  type Actor,
  type Asset,
  type Backend,
  type IngestEnvelope,
  type ReconstructionJob,
  type Result,
  type SourceRegistration,
  type TakeManifest,
} from "@/lib/contracts";
import { loadFixture } from "../helpers/fixtures";

export interface BackendHarness {
  backend: Backend;
  /** Two distinct authenticated users. */
  owner: NonNullable<Actor>;
  other: NonNullable<Actor>;
  /** The backend's current clock (used to build fresh/stale frames). */
  now(): Date;
}

type HarnessFactory = () => BackendHarness | Promise<BackendHarness>;

function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function expectCode<T>(r: Result<T>, code: string) {
  expect(r.ok ? "ok" : r.error.code).toBe(code);
}

function retarget<T>(fixture: T, ids: Record<string, string>): T {
  let text = JSON.stringify(fixture);
  for (const [from, to] of Object.entries(ids)) text = text.replaceAll(from, to);
  return JSON.parse(text) as T;
}

const key = () => newId("revision").replace("rev_", "key-");

/** A fresh project with the axis-box asset uploaded and revision 2 containing it. */
async function seedProject(h: BackendHarness) {
  const projectId = newId("project");
  const takeId = newId("take");
  const assetId = newId("asset");
  const ids = { prj_fixture_demo: projectId, tk_fixture_original: takeId, ast_fixture_axis_box: assetId };
  const full = retarget(loadFixture<TakeManifest>("take-manifest.original.json"), ids);
  const empty: TakeManifest = { ...full, scene: { ...full.scene, objects: [] } };

  const created = expectOk(
    await h.backend.projects.createProject(h.owner, {
      projectId,
      title: "Conformance project",
      initialManifest: empty,
      idempotencyKey: key(),
    }),
  );
  const asset = retarget(loadFixture<Asset>("asset.axis-box.json"), ids);
  expectOk(await h.backend.assets.putAsset(h.owner, asset));
  const saved = expectOk(
    await h.backend.projects.saveRevision(h.owner, {
      projectId,
      takeId,
      expectedRevision: 1,
      manifest: full,
      idempotencyKey: key(),
      message: "add axis box",
    }),
  );
  return { projectId, takeId, assetId, manifest: full, created, saved };
}

async function putFrameAsset(h: BackendHarness, projectId: string, envelope: IngestEnvelope) {
  const asset: Asset = {
    schemaVersion: 1,
    id: envelope.frame.assetId,
    projectId,
    kind: "frame",
    mimeType: envelope.frame.mimeType,
    byteSize: envelope.frame.byteSize,
    contentHash: envelope.frame.contentHash,
    storageKey: `test/${envelope.frame.assetId}`,
    origin: "capture",
    createdAt: h.now().toISOString(),
  };
  expectOk(await h.backend.assets.putAsset(h.owner, asset));
}

/** Register a live Chert source and return an envelope builder for it. */
async function seedLiveSource(h: BackendHarness, projectId: string) {
  const sourceId = newId("source");
  const sessionId = newId("captureSession");
  const reg = retarget(loadFixture<SourceRegistration & { createdAt?: string }>("source.chert-live.json"), {
    prj_fixture_demo: projectId,
    src_fixture_chert_call: sourceId,
    cap_fixture_call: sessionId,
  });
  delete reg.createdAt;
  expectOk(await h.backend.ingestion.registerSource(h.owner, reg));
  const base = retarget(loadFixture<IngestEnvelope>("ingest-envelope.chert-frame.json"), {
    prj_fixture_demo: projectId,
    src_fixture_chert_call: sourceId,
    cap_fixture_call: sessionId,
  });
  const frame = async (sequence: number, overrides: Partial<IngestEnvelope> = {}) => {
    const hash = `sha256:${sequence.toString(16).padStart(64, "0")}`;
    const envelope: IngestEnvelope = {
      ...base,
      sequence,
      sourceTimeUs: sequence * 100_000,
      capturedAt: h.now().toISOString(),
      frame: { ...base.frame, assetId: newId("asset"), contentHash: hash },
      ...overrides,
    };
    await putFrameAsset(h, projectId, envelope);
    return envelope;
  };
  return { sourceId, sessionId, frame };
}

export function describeBackendConformance(name: string, makeHarness: HarnessFactory) {
  describe(`${name}: ProjectRepository (CT-003)`, () => {
    it("creates a project whose original take starts at revision 1", async () => {
      const h = await makeHarness();
      const { projectId, takeId, created } = await seedProject(h);
      expect(created.revision.revision).toBe(1);
      expect(created.project.activeTakeId).toBe(takeId);
      const project = expectOk(await h.backend.projects.getProject(h.owner, projectId));
      expect(project.ownerId).toBe(h.owner.userId);
      const first = expectOk(await h.backend.projects.getRevision(h.owner, projectId, takeId, 1));
      expect(first.origin).toBe("create");
    });

    it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
      const h = await makeHarness();
      const { projectId, takeId } = await seedProject(h);
      expectCode(await h.backend.projects.getProject(null, projectId), "UNAUTHORIZED");
      expectCode(await h.backend.projects.getRevision(null, projectId, takeId), "UNAUTHORIZED");
    });

    it("hides another user's project as NOT_FOUND for reads and writes", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      expectCode(await h.backend.projects.getProject(h.other, projectId), "NOT_FOUND");
      expectCode(await h.backend.projects.listTakes(h.other, projectId), "NOT_FOUND");
      expectCode(
        await h.backend.projects.saveRevision(h.other, {
          projectId,
          takeId,
          expectedRevision: 2,
          manifest,
          idempotencyKey: key(),
          message: null,
        }),
        "NOT_FOUND",
      );
    });

    it("saves with compare-and-swap; a stale save conflicts instead of overwriting", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      const deviceA = structuredClone(manifest);
      deviceA.scene.objects[0].name = "Edited on laptop";
      const a = expectOk(
        await h.backend.projects.saveRevision(h.owner, {
          projectId, takeId, expectedRevision: 2, manifest: deviceA, idempotencyKey: key(), message: null,
        }),
      );
      expect(a.revision).toBe(3);

      const deviceB = structuredClone(manifest);
      deviceB.scene.objects[0].name = "Edited on phone";
      const b = await h.backend.projects.saveRevision(h.owner, {
        projectId, takeId, expectedRevision: 2, manifest: deviceB, idempotencyKey: key(), message: null,
      });
      expectCode(b, "REVISION_CONFLICT");
      if (!b.ok) expect(b.error.details).toMatchObject({ expectedRevision: 2, currentRevision: 3 });

      const head = expectOk(await h.backend.projects.getRevision(h.owner, projectId, takeId));
      expect(head.number).toBe(3);
      expect(head.manifest.scene.objects[0].name).toBe("Edited on laptop");
    });

    it("replays an idempotent retry and rejects a reused key with a different payload", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      const req = { projectId, takeId, expectedRevision: 2, manifest, idempotencyKey: key(), message: null };
      const first = expectOk(await h.backend.projects.saveRevision(h.owner, req));
      const retry = expectOk(await h.backend.projects.saveRevision(h.owner, req));
      expect(retry.revisionId).toBe(first.revisionId);
      const takes = expectOk(await h.backend.projects.listTakes(h.owner, projectId));
      expect(takes.find((t) => t.takeId === takeId)?.headRevision).toBe(3);
      expectCode(
        await h.backend.projects.saveRevision(h.owner, { ...req, message: "different" }),
        "IDEMPOTENCY_KEY_REUSED",
      );
    });

    it("rejects manifests that reference assets never uploaded", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      const bad = structuredClone(manifest);
      bad.scene.objects[0].geometry.assetId = newId("asset");
      const r = await h.backend.projects.saveRevision(h.owner, {
        projectId, takeId, expectedRevision: 2, manifest: bad, idempotencyKey: key(), message: null,
      });
      expectCode(r, "INVALID_ASSET_REFERENCE");
    });

    it("rejects schema-invalid manifests with INVALID_SCHEMA issues", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      const bad = structuredClone(manifest) as unknown as { scene: { objects: { transform: { rotation: number[] } }[] } };
      bad.scene.objects[0].transform.rotation = [0, 0, 0, 2];
      const r = await h.backend.projects.saveRevision(h.owner, {
        projectId, takeId, expectedRevision: 2, manifest: bad as unknown as TakeManifest, idempotencyKey: key(), message: null,
      });
      expectCode(r, "INVALID_SCHEMA");
    });

    it("forks at an exact revision; editing the fork never changes the original", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest, saved } = await seedProject(h);
      const forkId = newId("take");
      const fork = expectOk(
        await h.backend.projects.forkTake(h.owner, {
          projectId, fromTakeId: takeId, fromRevision: 2, newTakeId: forkId, name: "Alternate", idempotencyKey: key(),
        }),
      );
      expect(fork).toMatchObject({ takeId: forkId, revision: 1, parent: { takeId, revisionId: saved.revisionId } });

      const forkHead = expectOk(await h.backend.projects.getRevision(h.owner, projectId, forkId));
      expect(forkHead.manifest.take.parent).toEqual({ takeId, revisionId: saved.revisionId });
      const edited = structuredClone(forkHead.manifest);
      edited.scene.objects[0].transform.position = [1, 0.45, 0];
      edited.scene.objects[0].transform.scale = [1.5, 1.5, 1.5];
      expectOk(
        await h.backend.projects.saveRevision(h.owner, {
          projectId, takeId: forkId, expectedRevision: 1, manifest: edited, idempotencyKey: key(), message: null,
        }),
      );

      const originalHead = expectOk(await h.backend.projects.getRevision(h.owner, projectId, takeId));
      expect(canonicalJson(originalHead.manifest)).toBe(canonicalJson(manifest));
      const takes = expectOk(await h.backend.projects.listTakes(h.owner, projectId));
      expect(takes.map((t) => t.takeId).sort()).toEqual([takeId, forkId].sort());
    });

    it("round-trips a saved manifest exactly and returns copies, not live state", async () => {
      const h = await makeHarness();
      const { projectId, takeId, manifest } = await seedProject(h);
      const head = expectOk(await h.backend.projects.getRevision(h.owner, projectId, takeId));
      expect(canonicalJson(head.manifest)).toBe(canonicalJson(manifest));
      head.manifest.scene.objects[0].name = "mutated by caller";
      const again = expectOk(await h.backend.projects.getRevision(h.owner, projectId, takeId));
      expect(again.manifest.scene.objects[0].name).toBe(manifest.scene.objects[0].name);
    });
  });

  describe(`${name}: IngestionGateway (CT-002)`, () => {
    it("accepts an image frame once and replays the duplicate idempotently", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const sourceId = newId("source");
      const ids = { prj_fixture_demo: projectId, src_fixture_anchor_photo: sourceId };
      const reg = retarget(loadFixture<SourceRegistration & { createdAt?: string }>("source.image-upload.json"), ids);
      delete reg.createdAt;
      const photo: Asset = {
        schemaVersion: 1, id: reg.assetId!, projectId, kind: "image", mimeType: "image/jpeg", byteSize: 734003,
        contentHash: reg.contentHash!, storageKey: "test/photo", origin: "upload", createdAt: h.now().toISOString(),
      };
      expectOk(await h.backend.assets.putAsset(h.owner, photo));
      expectOk(await h.backend.ingestion.registerSource(h.owner, reg));
      const envelope = retarget(loadFixture<IngestEnvelope>("ingest-envelope.image-upload.json"), ids);
      await putFrameAsset(h, projectId, envelope);

      const first = expectOk(await h.backend.ingestion.ingest(h.owner, envelope));
      expect(first).toMatchObject({ status: "accepted", sequence: 0, outOfOrder: false, latestSequence: 0 });
      const again = expectOk(await h.backend.ingestion.ingest(h.owner, envelope));
      expect(again).toMatchObject({ status: "duplicate", observationId: first.observationId });
      const list = expectOk(await h.backend.ingestion.listObservations(h.owner, projectId, sourceId));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ sourceTimeUs: 0, mode: "evidence", frame: envelope.frame });
    });

    it("rejects reuse of a sequence with different content as DUPLICATE", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const first = await live.frame(1);
      expectOk(await h.backend.ingestion.ingest(h.owner, first));
      const clash: IngestEnvelope = {
        ...first,
        frame: { ...first.frame, assetId: newId("asset"), contentHash: `sha256:${"f".repeat(64)}` },
      };
      await putFrameAsset(h, projectId, clash);
      expectCode(await h.backend.ingestion.ingest(h.owner, clash), "DUPLICATE");
    });

    it("stores out-of-order live frames without moving latest backwards", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      for (const seq of [0, 2]) expectOk(await h.backend.ingestion.ingest(h.owner, await live.frame(seq)));
      const late = expectOk(await h.backend.ingestion.ingest(h.owner, await live.frame(1)));
      expect(late).toMatchObject({ status: "accepted", outOfOrder: true, latestSequence: 2 });
      const latest = expectOk(await h.backend.ingestion.latestObservation(h.owner, projectId, live.sourceId));
      expect(latest.sequence).toBe(2);
      const list = expectOk(await h.backend.ingestion.listObservations(h.owner, projectId, live.sourceId));
      expect(list.map((o) => o.sequence)).toEqual([0, 1, 2]);
    });

    it("drops stale preview frames but keeps equally old evidence", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const old = new Date(h.now().getTime() - 10_000).toISOString();
      expectCode(
        await h.backend.ingestion.ingest(h.owner, await live.frame(5, { mode: "preview", capturedAt: old })),
        "STALE_FRAME",
      );
      expectOk(await h.backend.ingestion.ingest(h.owner, await live.frame(6, { mode: "evidence", capturedAt: old })));
    });

    it("requires the frame asset to be uploaded before ingestion", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const envelope = await live.frame(1);
      envelope.frame = { ...envelope.frame, assetId: newId("asset") };
      expectCode(await h.backend.ingestion.ingest(h.owner, envelope), "MISSING_ASSET");
    });

    it("rejects unsupported media", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const gif = await live.frame(1);
      gif.frame = { ...gif.frame, mimeType: "image/gif" };
      expectCode(await h.backend.ingestion.ingest(h.owner, gif), "UNSUPPORTED_MEDIA");
    });

    it("upload and Chert adapters produce equivalent observations for the same frame", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const chertEnvelope = await live.frame(0);
      const chert = expectOk(await h.backend.ingestion.ingest(h.owner, chertEnvelope));

      const uploadSourceId = newId("source");
      const photoHash = chertEnvelope.frame.contentHash;
      const photoAsset: Asset = {
        schemaVersion: 1, id: newId("asset"), projectId, kind: "image", mimeType: "image/jpeg",
        byteSize: chertEnvelope.frame.byteSize, contentHash: photoHash, storageKey: "test/same-frame",
        origin: "upload", createdAt: h.now().toISOString(),
      };
      expectOk(await h.backend.assets.putAsset(h.owner, photoAsset));
      expectOk(
        await h.backend.ingestion.registerSource(h.owner, {
          schemaVersion: 1, id: uploadSourceId, projectId, adapter: "upload",
          media: { kind: "image", mimeType: "image/jpeg", width: chertEnvelope.frame.width, height: chertEnvelope.frame.height },
          assetId: photoAsset.id, contentHash: photoHash, capturedAt: null, captureSessionId: null,
          consent: { basis: "owner_upload", recordedAt: h.now().toISOString(), note: null },
        }),
      );
      const upload = expectOk(
        await h.backend.ingestion.ingest(h.owner, {
          ...chertEnvelope, sourceId: uploadSourceId, adapter: "upload", captureSessionId: null, sequence: 0, sourceTimeUs: 0,
        }),
      );

      const a = expectOk(await h.backend.ingestion.latestObservation(h.owner, projectId, live.sourceId));
      const b = expectOk(await h.backend.ingestion.latestObservation(h.owner, projectId, uploadSourceId));
      expect(chert.status).toBe(upload.status);
      const comparable = (o: typeof a) => ({ frame: o.frame, mode: o.mode, quality: o.quality, maskAssetIds: o.maskAssetIds });
      expect(comparable(b)).toEqual(comparable(a));
    });

    it("hides sources from other users and requires sign-in", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const live = await seedLiveSource(h, projectId);
      const envelope = await live.frame(1);
      expectCode(await h.backend.ingestion.ingest(null, envelope), "UNAUTHORIZED");
      expectCode(await h.backend.ingestion.ingest(h.other, envelope), "NOT_FOUND");
      expectCode(await h.backend.ingestion.listObservations(h.other, projectId, live.sourceId), "NOT_FOUND");
    });
  });

  describe(`${name}: JobStore (CT-002)`, () => {
    const newJob = (projectId: string): ReconstructionJob => ({
      ...retarget(loadFixture<ReconstructionJob>("reconstruction-job.succeeded.json"), { prj_fixture_demo: projectId }),
      id: newId("job"),
      state: "queued",
      provider: "fal",
      providerModel: "fal-ai/sam-3/3d-objects",
      history: [],
      output: null,
    });

    it("tracks a job through submitted -> succeeded and rejects leaving a terminal state", async () => {
      const h = await makeHarness();
      const { projectId, assetId } = await seedProject(h);
      const job = expectOk(await h.backend.jobs.createJob(h.owner, newJob(projectId)));
      expectOk(await h.backend.jobs.transitionJob(h.owner, projectId, job.id, "submitted", { providerRequestId: "req_abc" }));
      const done = expectOk(
        await h.backend.jobs.transitionJob(h.owner, projectId, job.id, "succeeded", {
          output: { meshAssetId: assetId, splatAssetId: null, maskAssetIds: [], rawAssetIds: [] },
        }),
      );
      expect(done.history.map((e) => e.state)).toEqual(["submitted", "succeeded"]);
      expectCode(await h.backend.jobs.transitionJob(h.owner, projectId, job.id, "running"), "INVALID_TRANSITION");
      const stored = expectOk(await h.backend.jobs.getJob(h.owner, projectId, job.id));
      expect(stored.state).toBe("succeeded");
    });

    it("hides jobs from other users", async () => {
      const h = await makeHarness();
      const { projectId } = await seedProject(h);
      const job = expectOk(await h.backend.jobs.createJob(h.owner, newJob(projectId)));
      expectCode(await h.backend.jobs.getJob(h.other, projectId, job.id), "NOT_FOUND");
    });
  });
}
