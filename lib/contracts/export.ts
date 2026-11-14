/**
 * CT-004 — exports. An export pins a revision; later edits never change an
 * in-flight export. The manifest records the actual format and omissions.
 */
import { z } from "zod";
import {
  AssetId,
  CameraId,
  Confirmation,
  ContentHash,
  ExportId,
  ProjectId,
  RevisionId,
  SchemaVersion,
  TakeId,
  Timestamp,
} from "./common";

export const ExportFormat = z.enum(["png", "glb", "webm", "mp4", "project_json"]);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportSpec = z
  .strictObject({
    projectId: ProjectId,
    takeId: TakeId,
    revisionId: RevisionId,
    /** null = the take's active camera. */
    cameraId: CameraId.nullable(),
    appearanceMode: z.enum(["mesh", "capture_appearance", "wireframe"]),
    frames: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("still"), frame: z.int().nonnegative() }),
      z.strictObject({
        kind: z.literal("range"),
        startFrame: z.int().nonnegative(),
        endFrame: z.int().positive(),
      }),
    ]),
    resolution: z.strictObject({
      width: z.int().min(1).max(8192),
      height: z.int().min(1).max(8192),
    }),
    background: z.enum(["transparent", "solid", "source_plate"]),
    requestedFormat: ExportFormat,
  })
  .refine((s) => s.frames.kind === "still" || s.frames.endFrame > s.frames.startFrame, {
    message: "range endFrame must be greater than startFrame",
    path: ["frames"],
  });
export type ExportSpec = z.infer<typeof ExportSpec>;

export const ExportManifest = z.strictObject({
  schemaVersion: SchemaVersion,
  id: ExportId,
  spec: ExportSpec,
  /** What was actually produced (e.g. webm when mp4 was unsupported). */
  actualFormat: ExportFormat,
  mimeType: z.string().min(3),
  outputs: z.array(
    z.strictObject({
      assetId: AssetId.nullable(),
      fileName: z.string().min(1).max(200),
      byteSize: z.int().nonnegative(),
      contentHash: ContentHash,
    }),
  ),
  /** Features not carried into this format, e.g. "splats", "joint semantics". */
  omissions: z.array(z.string().max(200)),
  scaleStatus: Confirmation,
  engine: z.strictObject({ name: z.string(), version: z.string() }),
  createdAt: Timestamp,
});
export type ExportManifest = z.infer<typeof ExportManifest>;
