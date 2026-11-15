/** Private server-side bytes for provider jobs; ownership is checked through the ports. */
import { err, ok, sha256, type Actor, type Backend } from "@/lib/contracts";
import type { BlobStore } from "@/lib/capture/blob-store";
import { parseAssetKey } from "@/lib/platform/blob-store";
import { supabaseAdmin } from "@/lib/server/auth";
import { supabaseServerConfig } from "@/lib/server/env";
import { checkObjectSize, objectPath, storageKeyFor } from "@/lib/server/storage";

export function serverBlobs(backend: Backend, actor: Actor): BlobStore {
  const bucket = () => supabaseAdmin().storage.from(supabaseServerConfig().bucket);
  return {
    async put(key, bytes, mimeType) {
      const ids = parseAssetKey(key);
      if (!ids) return err("INVALID_SCHEMA", "invalid asset key");
      const owner = await backend.projects.getProject(actor, ids.projectId);
      if (!owner.ok) return owner;
      const size = checkObjectSize(bytes.byteLength);
      if (!size.ok) return size;
      const path = objectPath(ids.projectId, ids.assetId);
      const uploaded = await bucket().upload(path, bytes, { contentType: mimeType, upsert: false });
      if (uploaded.error) {
        if (!/exist|duplicate/i.test(uploaded.error.message)) return err("PROVIDER_UNAVAILABLE", "private storage upload failed");
        const existing = await bucket().download(path);
        if (existing.error || !existing.data) return err("PROVIDER_UNAVAILABLE", "could not verify interrupted upload");
        if (await sha256(new Uint8Array(await existing.data.arrayBuffer())) !== await sha256(bytes))
          return err("DUPLICATE", "stored asset has different bytes");
      }
      return ok({ storageKey: storageKeyFor(ids.projectId, ids.assetId) });
    },
    async get(key) {
      const ids = parseAssetKey(key);
      if (!ids) return err("MISSING_ASSET", "invalid asset key");
      const asset = await backend.assets.getAsset(actor, ids.projectId, ids.assetId);
      if (!asset.ok) return asset;
      if (asset.value.storageKey !== key) return err("MISSING_ASSET", "storage key does not match the asset");
      const result = await bucket().download(objectPath(ids.projectId, ids.assetId));
      if (result.error || !result.data) return err("MISSING_ASSET", "private storage download failed");
      return ok({ bytes: new Uint8Array(await result.data.arrayBuffer()), mimeType: asset.value.mimeType });
    },
  };
}
