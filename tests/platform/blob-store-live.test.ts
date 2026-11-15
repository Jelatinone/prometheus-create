import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId, sha256 } from "@/lib/contracts";
import { createCaptureProject } from "@/lib/capture/project";
import { storeProjectAsset } from "@/lib/capture/assets";
import { assetStorageKey } from "@/lib/capture/blob-store";
import { PlatformBlobStore } from "@/lib/platform/blob-store";
import { HttpBackend } from "@/lib/platform/http-backend";
import { setRouteContextForTests } from "@/lib/server/route";
import { supabaseAdmin } from "@/lib/server/auth";
import { supabaseServerConfig } from "@/lib/server/env";
import { closePlatformHarness, platformEnv, platformHarness, type PlatformHarness } from "./harness";
import { PLATFORM_ORIGIN, routeFetch } from "./route-fetch";
import { expectOk, captureFixture } from "../capture/helpers";

const env = platformEnv();
if (!env.ready) describe("PlatformBlobStore live", () => { it.skip(env.reason, () => {}); });
else {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });
  let h: PlatformHarness; let api: HttpBackend; let blobs: PlatformBlobStore; let projectId: string;
  const paths = new Set<string>();
  const bytes = captureFixture("upright-64x48.png");
  beforeAll(async () => {
    h = await platformHarness(); setRouteContextForTests({ backend: h.backend });
    api = new HttpBackend({ baseUrl: PLATFORM_ORIGIN, fetch: routeFetch, authorize: actor => actor ? { headers: { authorization: `Bearer ${actor.userId === h.owner.actor.userId ? h.owner.accessToken : h.other.accessToken}` } } : {} });
    blobs = new PlatformBlobStore({ api, actor: h.owner.actor });
    projectId = expectOk(await createCaptureProject(api.projects, h.owner.actor, "V2 blob store verification")).project.id;
  });
  afterAll(async () => {
    if (paths.size) await supabaseAdmin().storage.from(supabaseServerConfig().bucket).remove([...paths]);
    setRouteContextForTests({}); await closePlatformHarness();
  });
  describe("PlatformBlobStore live HTTP + private storage", () => {
    it("round-trips bytes, retries identical content, and rejects different content at the same ID", async () => {
      const deps = { assets: api.assets, blobs, actor: h.owner.actor };
      const a = expectOk(await storeProjectAsset(deps, projectId, bytes, { kind: "frame", mimeType: "image/png", origin: "capture" }));
      paths.add(`projects/${projectId}/${a.id}`);
      expect(expectOk(await blobs.get(a.storageKey)).bytes).toEqual(bytes);
      const retry = expectOk(await storeProjectAsset(deps, projectId, bytes, { kind: "frame", mimeType: "image/png", origin: "capture" }));
      expect(retry.id).toBe(a.id);
      const changed = await blobs.put(a.storageKey, new Uint8Array([1, 2, 3]), "image/png");
      expect(changed.ok ? null : changed.error.code).toBe("DUPLICATE");
      const other = new PlatformBlobStore({ api, actor: h.other.actor });
      const denied = await other.get(a.storageKey);
      expect(denied.ok ? null : denied.error.code).toBe("MISSING_ASSET");
      const deniedPut = await other.put(a.storageKey, bytes, "image/png");
      expect(deniedPut.ok ? null : deniedPut.error.code).toBe("NOT_FOUND");
    });
    it("recovers bytes uploaded before asset metadata was recorded", async () => {
      const id = newId("asset"); paths.add(`projects/${projectId}/${id}`);
      const key = assetStorageKey(projectId, id);
      const first = expectOk(await blobs.put(key, bytes, "image/png"));
      const conflict = await blobs.put(key, new Uint8Array([1, 2, 3]), "image/png");
      expect(conflict.ok ? null : conflict.error.code).toBe("DUPLICATE");
      const retry = expectOk(await blobs.put(key, bytes, "image/png"));
      expect(retry.storageKey).toBe(first.storageKey);
      expectOk(await api.assets.putAsset(h.owner.actor, { schemaVersion: 1, id, projectId, kind: "frame", mimeType: "image/png", byteSize: bytes.length, contentHash: await sha256(bytes), storageKey: retry.storageKey, origin: "capture", createdAt: new Date().toISOString() }));
      expect(expectOk(await blobs.get(retry.storageKey)).bytes).toEqual(bytes);
    });
  });
}
