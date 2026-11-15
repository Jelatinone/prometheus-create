/**
 * Platform-local HTTP request shapes. They compose contract primitives and
 * are not part of lib/contracts; promoting them there would be a contract
 * proposal (see docs/changes/HK-003.md).
 */
import { z } from "zod";
import { AssetKind } from "@/lib/contracts/asset";
import { AssetId, ProjectId } from "@/lib/contracts/common";
import { JobState, ReconstructionJob } from "@/lib/contracts/ingestion";

/**
 * POST /api/assets/upload-url. `kind` is optional so generic byte stores
 * (capture's BlobStore.put) can upload before the asset record exists; the
 * kind's media rules are then enforced by POST /api/assets.
 */
export const UploadUrlRequest = z.strictObject({
  projectId: ProjectId,
  assetId: AssetId,
  kind: AssetKind.optional(),
  mimeType: z.string().min(3).max(100),
  byteSize: z.int().positive(),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequest>;

/** POST /api/jobs/:jobId/transition */
export const JobTransitionRequest = z.strictObject({
  projectId: ProjectId,
  to: JobState,
  patch: z
    .strictObject({
      providerRequestId: ReconstructionJob.shape.providerRequestId.optional(),
      output: ReconstructionJob.shape.output.optional(),
      error: ReconstructionJob.shape.error.optional(),
    })
    .optional(),
});
export type JobTransitionRequest = z.infer<typeof JobTransitionRequest>;

/** `?revision=<n>` on GET .../revisions */
export const RevisionNumberQuery = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, "expected a revision number >= 1")
  .transform(Number);
