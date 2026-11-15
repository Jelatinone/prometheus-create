import { expect, test } from "vitest";
import type { Backend } from "@/lib/contracts/ports";
import { assetStorageKey, type BlobStore } from "@/lib/capture/blob-store";
import { HttpBackend } from "@/lib/platform/http-backend";
import { PlatformBlobStore, parseAssetKey } from "@/lib/platform/blob-store";

// Capture runs on the platform client unchanged: HttpBackend is a Backend and
// PlatformBlobStore is a capture BlobStore (compile-time checks), and the keys
// capture requests are ones the platform store accepts.
test("platform client satisfies the capture seams", () => {
  const api: Backend = new HttpBackend({ baseUrl: "http://127.0.0.1:1" });
  const blobs: BlobStore = new PlatformBlobStore({ api: api as HttpBackend, actor: { userId: "u" } });
  expect(blobs).toBeInstanceOf(PlatformBlobStore);

  const projectId = "prj_0123456789abcdef";
  const assetId = "ast_0123456789abcdef0123456789abcdef01234567";
  expect(parseAssetKey(assetStorageKey(projectId, assetId))).toEqual({ projectId, assetId });
});
