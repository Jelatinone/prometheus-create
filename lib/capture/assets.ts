/**
 * Store and load project asset bytes: BlobStore for bytes, AssetCatalog for
 * the immutable metadata record. Shared by capture and reconstruction.
 */
import { err, ok, sha256, type Actor, type Asset, type AssetCatalog, type Result } from "@/lib/contracts";
import { assetStorageKey, type BlobStore } from "./blob-store";

export interface AssetDeps {
  assets: AssetCatalog;
  blobs: BlobStore;
  actor: Actor;
  now?: () => Date;
}

/**
 * Deterministic per-project asset ID from content. Re-uploading the same bytes
 * (a retried request, a duplicate frame) reuses the asset instead of leaving
 * orphans, and the ID stays unique across projects. The kind is part of the
 * identity, so identical bytes used as both a frame and a mask stay distinct.
 */
export async function projectAssetId(projectId: string, kind: Asset["kind"], contentHash: string): Promise<string> {
  const digest = await sha256(`${projectId}:${kind}:${contentHash}`);
  return `ast_${digest.slice("sha256:".length, "sha256:".length + 40)}`;
}

/** Store bytes, then record the asset. Idempotent for identical content. */
export async function storeProjectAsset(
  deps: AssetDeps,
  projectId: string,
  bytes: Uint8Array,
  meta: { kind: Asset["kind"]; mimeType: string; origin: Asset["origin"]; contentHash?: string },
): Promise<Result<Asset>> {
  const contentHash = meta.contentHash ?? (await sha256(bytes));
  const id = await projectAssetId(projectId, meta.kind, contentHash);
  const storageKey = assetStorageKey(projectId, id);
  const stored = await deps.blobs.put(storageKey, bytes, meta.mimeType);
  if (!stored.ok) return stored;
  return deps.assets.putAsset(deps.actor, {
    schemaVersion: 1,
    id,
    projectId,
    kind: meta.kind,
    mimeType: meta.mimeType,
    byteSize: bytes.byteLength,
    contentHash,
    storageKey,
    origin: meta.origin,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
}

/** Load an asset's bytes and verify them against its recorded hash. */
export async function loadProjectAsset(
  deps: AssetDeps,
  projectId: string,
  assetId: string,
): Promise<Result<{ asset: Asset; bytes: Uint8Array }>> {
  const asset = await deps.assets.getAsset(deps.actor, projectId, assetId);
  if (!asset.ok) return asset;
  const blob = await deps.blobs.get(asset.value.storageKey);
  if (!blob.ok) return blob;
  if ((await sha256(blob.value.bytes)) !== asset.value.contentHash)
    return err("MISSING_ASSET", `stored bytes for ${assetId} do not match its content hash`);
  return ok({ asset: asset.value, bytes: blob.value.bytes });
}
