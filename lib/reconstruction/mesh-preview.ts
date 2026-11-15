/**
 * Cached simplified preview of a stored mesh (CP-010).
 *
 * The full-resolution mesh stays the object's geometry and is never modified.
 * The preview is a separate `mesh` asset whose ID is derived from the source
 * mesh's asset ID and the recipe, so anyone holding `geometry.assetId` can
 * find it (`meshPreviewAssetId`) without a contract change and without
 * recomputing it. Its `contentHash` is still the hash of its own bytes.
 */
import type { Asset } from "@/lib/contracts";
import { loadProjectAsset, storeProjectAsset, type AssetDeps } from "@/lib/capture/assets";
import { simplifyGlb } from "./mesh-simplify";
import { MESH_PREVIEW_TRIANGLES, meshPreviewAssetId } from "./mesh-preview-id";

export { MESH_PREVIEW_RECIPE, MESH_PREVIEW_TRIANGLES, meshPreviewAssetId } from "./mesh-preview-id";
const GLB_MIME = "model/gltf-binary";

export interface MeshPreview {
  /** The stored preview, or null when there is none (see note). */
  asset: Asset | null;
  /** Why there is no preview, or what it is; null when nothing to report. */
  note: string | null;
}

/** Look up an existing preview without computing one. */
export async function findMeshPreview(deps: AssetDeps, projectId: string, meshAssetId: string): Promise<MeshPreview> {
  const found = await deps.assets.getAsset(deps.actor, projectId, await meshPreviewAssetId(projectId, meshAssetId));
  return found.ok ? { asset: found.value, note: null } : { asset: null, note: "no stored preview; the full mesh is the only geometry" };
}

/**
 * Return the stored preview of `mesh`, creating it if needed. Idempotent and
 * never throws: any problem yields `asset: null` and a note, and the full mesh
 * stays usable. Pass `bytes` when the caller already holds the mesh.
 */
export async function ensureMeshPreview(
  deps: AssetDeps,
  projectId: string,
  mesh: Asset,
  bytes?: Uint8Array,
  targetTriangles = MESH_PREVIEW_TRIANGLES,
): Promise<MeshPreview> {
  try {
    const id = await meshPreviewAssetId(projectId, mesh.id, targetTriangles);
    const existing = await deps.assets.getAsset(deps.actor, projectId, id);
    if (existing.ok) return { asset: existing.value, note: null };
    let source = bytes;
    if (!source) {
      const loaded = await loadProjectAsset(deps, projectId, mesh.id);
      if (!loaded.ok) return { asset: null, note: `mesh could not be loaded for a preview (${loaded.error.message})` };
      source = loaded.value.bytes;
    }
    const simplified = await simplifyGlb(source, { targetTriangles });
    if (!simplified.ok) return { asset: null, note: `no preview: ${simplified.error.message}` };
    if (simplified.value.status === "skipped") return { asset: null, note: `no preview needed: ${simplified.value.reason}` };
    const stored = await storeProjectAsset(deps, projectId, simplified.value.bytes, { kind: "mesh", mimeType: GLB_MIME, origin: "provider", id });
    if (!stored.ok) return { asset: null, note: `preview could not be stored (${stored.error.message})` };
    const { triangles, sourceTriangles } = simplified.value;
    return { asset: stored.value, note: `preview ${triangles} of ${sourceTriangles} triangles` };
  } catch (e) {
    return { asset: null, note: `no preview: ${e instanceof Error ? e.message : String(e)}` };
  }
}
