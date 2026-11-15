import { expect, it } from "vitest";
import { ok } from "@/lib/contracts";
import { MemoryBlobStore, loadProjectAsset, storeProjectAsset, type BlobStore } from "@/lib/capture";
import { captureFixture, captureHarness, expectOk } from "./helpers";

it("records the key returned by storage and reloads bytes from that canonical key", async () => {
  const h = await captureHarness();
  const backing = new MemoryBlobStore();
  const blobs: BlobStore = {
    async put(requestedKey, bytes, mimeType) {
      const canonical = `project-assets/${requestedKey.replace("/assets/", "/")}`;
      expectOk(await backing.put(canonical, bytes, mimeType));
      return ok({ storageKey: canonical });
    },
    get: (key) => backing.get(key),
  };
  const deps = { assets: h.backend.assets, blobs, actor: h.actor };
  const bytes = captureFixture("upright-64x48.png");
  const asset = expectOk(await storeProjectAsset(deps, h.projectId, bytes, {
    kind: "image", mimeType: "image/png", origin: "upload",
  }));
  expect(asset.storageKey).toBe(`project-assets/projects/${h.projectId}/${asset.id}`);
  expect(expectOk(await loadProjectAsset(deps, h.projectId, asset.id)).bytes).toEqual(bytes);
});
