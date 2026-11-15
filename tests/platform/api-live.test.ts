/**
 * The HTTP handlers against the real stack: TigerData test database, real
 * Supabase users, and private Supabase Storage with signed direct uploads.
 * Covers the HK-003 visible flow and its edge cases at the API boundary.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { newId, sha256, type Asset, type Revision, type SaveRevisionResponse } from "@/lib/contracts";
import * as api from "@/lib/server/api";
import { supabaseAdmin } from "@/lib/server/auth";
import { supabaseServerConfig } from "@/lib/server/env";
import { retargetedFixture } from "@/lib/platform/fixture-project";
import { REPO_ROOT } from "../helpers/fixtures";
import { closePlatformHarness, platformEnv, platformHarness, type PlatformHarness } from "./harness";

const env = platformEnv();
const GLB = new Uint8Array(readFileSync(resolve(REPO_ROOT, "public/fixtures/axis-box.glb")));

const req = (method: string, body?: unknown, url = "http://localhost/api") =>
  new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const key = () => newId("revision").replace("rev_", "key-");

if (!env.ready) {
  describe("platform API (live)", () => {
    it.skip(`skipped: ${env.reason}`, () => {});
  });
} else {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

  let h: PlatformHarness;
  let owner: api.ApiContext;
  let other: api.ApiContext;
  let anonymous: api.ApiContext;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    h = await platformHarness();
    owner = { backend: h.backend, actor: h.owner.actor };
    other = { backend: h.backend, actor: h.other.actor };
    anonymous = { backend: h.backend, actor: null };
  });

  afterAll(async () => {
    if (uploadedPaths.length) await supabaseAdmin().storage.from(supabaseServerConfig().bucket).remove(uploadedPaths);
    await closePlatformHarness();
  });

  /** Upload the axis box through the signed-URL path and register it. */
  async function uploadAxisBox(ctx: api.ApiContext, projectId: string, assetId: string) {
    const signed = await api.requestUpload(
      ctx,
      req("POST", { projectId, assetId, kind: "mesh", mimeType: "model/gltf-binary", byteSize: GLB.byteLength }),
    );
    expect(signed.status).toBe(201);
    const { upload } = await signed.json();
    uploadedPaths.push(upload.path);
    const browserLike = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
      { auth: { persistSession: false } },
    );
    const put = await browserLike.storage
      .from(upload.bucket)
      .uploadToSignedUrl(upload.path, upload.token, new Blob([GLB], { type: "model/gltf-binary" }), {
        contentType: "model/gltf-binary",
      });
    expect(put.error).toBeNull();
    const asset: Asset = {
      schemaVersion: 1,
      id: assetId,
      projectId,
      kind: "mesh",
      mimeType: "model/gltf-binary",
      byteSize: GLB.byteLength,
      contentHash: await sha256(GLB),
      storageKey: upload.storageKey,
      origin: "fixture",
      createdAt: new Date().toISOString(),
    };
    return { asset, upload, response: await api.putAsset(ctx, req("POST", asset)) };
  }

  async function createFixtureProject() {
    const projectId = newId("project");
    const takeId = newId("take");
    const assetId = newId("asset");
    const manifest = retargetedFixture({ projectId, takeId, assetId });
    const empty = { ...manifest, scene: { ...manifest.scene, objects: [] } };
    const created = await api.createProject(
      owner,
      req("POST", { projectId, title: "HK-003 live API test (fixture)", initialManifest: empty, idempotencyKey: key() }),
    );
    expect(created.status).toBe(201);
    return { projectId, takeId, assetId, manifest };
  }

  const saveBody = (p: { projectId: string; takeId: string }, expectedRevision: number, manifest: unknown) => ({
    projectId: p.projectId,
    takeId: p.takeId,
    expectedRevision,
    manifest,
    idempotencyKey: key(),
    message: null,
  });

  describe("platform API (live): projects and revisions", () => {
    it("saves the fixture after a signed upload, reloads the same head, and rejects a stale save with 409", async () => {
      const p = await createFixtureProject();
      const { response: assetRes } = await uploadAxisBox(owner, p.projectId, p.assetId);
      expect(assetRes.status).toBe(201);

      const saved = await api.saveRevision(owner, req("POST", saveBody(p, 1, p.manifest)), p.projectId, p.takeId);
      expect(saved.status).toBe(201);
      const rev2: SaveRevisionResponse = await saved.json();
      expect(rev2.revision).toBe(2);
      expect(rev2.assetIds).toEqual([p.assetId]);

      // "Second session": a fresh read goes back to the database.
      const reload = await api.getRevision(owner, req("GET"), p.projectId, p.takeId);
      expect(reload.status).toBe(200);
      const head: Revision = await reload.json();
      expect(head).toMatchObject({ id: rev2.revisionId, number: 2, manifestHash: rev2.manifestHash });

      // Device A moves on to revision 3 ...
      const edited = structuredClone(p.manifest);
      edited.scene.objects[0].name = "Edited on laptop";
      expect((await api.saveRevision(owner, req("POST", saveBody(p, 2, edited)), p.projectId, p.takeId)).status).toBe(201);
      // ... device B still edits from revision 2.
      const stale = structuredClone(p.manifest);
      stale.scene.objects[0].name = "Edited on phone";
      const conflict = await api.saveRevision(owner, req("POST", saveBody(p, 2, stale)), p.projectId, p.takeId);
      expect(conflict.status).toBe(409);
      const body = await conflict.json();
      expect(body.error).toMatchObject({ code: "REVISION_CONFLICT", details: { expectedRevision: 2, currentRevision: 3 } });
      const after: Revision = await (await api.getRevision(owner, req("GET"), p.projectId, p.takeId)).json();
      expect(after.number).toBe(3);
      expect(after.manifest.scene.objects[0].name).toBe("Edited on laptop");

      // Exact older revisions stay readable.
      const old = await api.getRevision(
        owner,
        req("GET", undefined, "http://localhost/api?revision=2"),
        p.projectId,
        p.takeId,
      );
      expect(((await old.json()) as Revision).id).toBe(rev2.revisionId);
    });

    it("hides the project from another user (404) and requires sign-in (401)", async () => {
      const p = await createFixtureProject();
      for (const res of [
        await api.getProject(other, p.projectId),
        await api.listTakes(other, p.projectId),
        await api.getRevision(other, req("GET"), p.projectId, p.takeId),
        await api.saveRevision(other, req("POST", saveBody(p, 1, p.manifest)), p.projectId, p.takeId),
      ]) {
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe("NOT_FOUND");
      }
      const anon = await api.getProject(anonymous, p.projectId);
      expect(anon.status).toBe(401);
      expect((await anon.json()).error.code).toBe("UNAUTHORIZED");
    });

    it("rejects a manifest that references an unuploaded asset (422 INVALID_ASSET_REFERENCE)", async () => {
      const p = await createFixtureProject();
      const res = await api.saveRevision(owner, req("POST", saveBody(p, 1, p.manifest)), p.projectId, p.takeId);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatchObject({ code: "INVALID_ASSET_REFERENCE", details: { missing: [p.assetId] } });
    });

    it("replays a retried save with the same idempotency key", async () => {
      const p = await createFixtureProject();
      await uploadAxisBox(owner, p.projectId, p.assetId);
      const body = saveBody(p, 1, p.manifest);
      const first = await api.saveRevision(owner, req("POST", body), p.projectId, p.takeId);
      const retry = await api.saveRevision(owner, req("POST", body), p.projectId, p.takeId);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect((await retry.json()).revisionId).toBe((await first.json()).revisionId);
      const takes = await (await api.listTakes(owner, p.projectId)).json();
      expect(takes[0].headRevision).toBe(2);
      const reused = await api.saveRevision(owner, req("POST", { ...body, message: "different" }), p.projectId, p.takeId);
      expect(reused.status).toBe(409);
      expect((await reused.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });
  });

  describe("platform API (live): private storage", () => {
    it("serves uploaded bytes only through a signed URL", async () => {
      const p = await createFixtureProject();
      const { upload } = await uploadAxisBox(owner, p.projectId, p.assetId);
      const res = await api.getAsset(
        owner,
        req("GET", undefined, `http://localhost/api?projectId=${p.projectId}`),
        p.assetId,
      );
      expect(res.status).toBe(200);
      const { asset, download } = await res.json();
      expect(asset.storageKey).toBe(upload.storageKey);
      const signed = await fetch(download.url);
      expect(signed.status).toBe(200);
      expect(new Uint8Array(await signed.arrayBuffer())).toEqual(GLB);

      const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${upload.bucket}/${upload.path}`;
      const unsigned = await fetch(publicUrl);
      expect(unsigned.ok).toBe(false);
    });

    it("refuses metadata for bytes that were never uploaded, foreign keys and other users", async () => {
      const p = await createFixtureProject();
      const asset: Asset = {
        schemaVersion: 1,
        id: newId("asset"),
        projectId: p.projectId,
        kind: "mesh",
        mimeType: "model/gltf-binary",
        byteSize: GLB.byteLength,
        contentHash: await sha256(GLB),
        storageKey: `${supabaseServerConfig().bucket}/projects/${p.projectId}/${p.assetId}`,
        origin: "fixture",
        createdAt: new Date().toISOString(),
      };
      const notUploaded = await api.putAsset(owner, req("POST", { ...asset, storageKey: `${supabaseServerConfig().bucket}/projects/${p.projectId}/${asset.id}` }));
      expect(notUploaded.status).toBe(422);
      expect((await notUploaded.json()).error.code).toBe("MISSING_ASSET");
      const foreignKey = await api.putAsset(owner, req("POST", { ...asset, storageKey: "elsewhere/some-object" }));
      expect(foreignKey.status).toBe(422);
      expect((await foreignKey.json()).error.code).toBe("INVALID_SCHEMA");
      const otherUser = await api.requestUpload(
        other,
        req("POST", { projectId: p.projectId, assetId: newId("asset"), kind: "mesh", mimeType: "model/gltf-binary", byteSize: 10 }),
      );
      expect(otherUser.status).toBe(404);
      const tooBig = await api.requestUpload(
        owner,
        req("POST", { projectId: p.projectId, assetId: newId("asset"), kind: "frame", mimeType: "image/png", byteSize: 16 * 1024 * 1024 }),
      );
      expect(tooBig.status).toBe(413);
      const gif = await api.requestUpload(
        owner,
        req("POST", { projectId: p.projectId, assetId: newId("asset"), kind: "frame", mimeType: "image/gif", byteSize: 10 }),
      );
      expect(gif.status).toBe(415);
    });
  });
}
