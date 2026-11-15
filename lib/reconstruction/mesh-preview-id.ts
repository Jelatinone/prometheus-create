/**
 * Where a mesh's cached preview lives (CP-010). Client-safe leaf: the editor
 * can derive the preview asset ID from `geometry.assetId` and download it
 * through the private asset route, falling back to the full mesh on 404.
 */
import { sha256 } from "@/lib/contracts";
import { projectAssetId } from "@/lib/capture/assets";

/** Preview triangle budget, chosen after the CP-010 visual comparison (docs/changes/HK-011.md). */
export const MESH_PREVIEW_TRIANGLES = 100_000;
/** Bump when the simplifier's output for the same input changes, so old previews are not reused. */
export const MESH_PREVIEW_RECIPE = "mesh-preview:v1";

/** Deterministic asset ID of the preview of `meshAssetId` (exists only once ensured). */
export async function meshPreviewAssetId(projectId: string, meshAssetId: string, targetTriangles = MESH_PREVIEW_TRIANGLES): Promise<string> {
  return projectAssetId(projectId, "mesh", await sha256(`${MESH_PREVIEW_RECIPE}:${targetTriangles}:${meshAssetId}`));
}
