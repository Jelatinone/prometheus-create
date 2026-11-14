/**
 * Immutable binary assets (images, frames, masks, meshes, splats, exports).
 * Bytes live in private object storage; manifests reference assets by ID and
 * hash only. Signed URLs are temporary and never stored in a manifest.
 */
import { z } from "zod";
import { AssetId, ContentHash, ProjectId, Timestamp } from "./common";

export const AssetKind = z.enum([
  "image", // uploaded still photo
  "video", // uploaded clip
  "frame", // still extracted from a video/live source
  "mask", // binary mask aligned to a frame's pixel grid
  "mesh", // canonical-space GLB (normalized by an adapter)
  "splat", // optional appearance asset
  "collider", // simplified collision geometry
  "motion", // baked pose/motion cache
  "export", // PNG/GLB/video produced by export
  "provider_raw", // provider output retained before normalization
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetOrigin = z.enum([
  "upload",
  "capture",
  "provider",
  "editor",
  "export",
  "fixture",
]);

export const Asset = z.strictObject({
  schemaVersion: z.literal(1),
  id: AssetId,
  projectId: ProjectId,
  kind: AssetKind,
  mimeType: z.string().min(3).max(100),
  byteSize: z.int().nonnegative(),
  contentHash: ContentHash,
  /** Opaque private-storage key (bucket/path). Never a public URL. */
  storageKey: z.string().min(1).max(512),
  origin: AssetOrigin,
  createdAt: Timestamp,
});
export type Asset = z.infer<typeof Asset>;
