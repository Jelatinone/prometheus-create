/**
 * CT-003 — project persistence: immutable revisions with optimistic
 * compare-and-swap saves, and fork semantics (CT-001).
 *
 * A revision is a snapshot of one take: its TakeDocument plus its own copy of
 * the scene baseline (a TakeManifest). Forking copies the small manifest
 * into a new take while sharing immutable assets; the original is untouched.
 * No silent last-write-wins: a stale expectedRevision is REVISION_CONFLICT.
 */
import { z } from "zod";
import { cloneJson } from "./canonical";
import {
  AssetId,
  ContentHash,
  IdempotencyKey,
  ProjectId,
  RevisionId,
  SchemaVersion,
  TakeId,
  Timestamp,
  UserId,
  err,
  ok,
  type Result,
} from "./common";
import { Project, SceneDocument, TakeDocument } from "./scene";

export const TakeManifest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    projectId: ProjectId,
    take: TakeDocument,
    scene: SceneDocument,
  })
  .superRefine((m, ctx) => {
    if (m.take.projectId !== m.projectId)
      ctx.addIssue({
        code: "custom",
        path: ["take", "projectId"],
        message: "take.projectId must equal manifest projectId",
      });
    const objectIds = new Set(m.scene.objects.map((o) => o.id));
    const cameraIds = new Set(m.scene.cameras.map((c) => c.id));
    if (m.take.activeCameraId && !cameraIds.has(m.take.activeCameraId))
      ctx.addIssue({
        code: "custom",
        path: ["take", "activeCameraId"],
        message: `unknown camera ${m.take.activeCameraId}`,
      });
    m.take.tracks.forEach((t, i) => {
      const known =
        t.target.kind === "object"
          ? objectIds.has(t.target.objectId)
          : cameraIds.has(t.target.cameraId);
      if (!known)
        ctx.addIssue({
          code: "custom",
          path: ["take", "tracks", i, "target"],
          message: "track target does not exist in the scene",
        });
    });
  });
export type TakeManifest = z.infer<typeof TakeManifest>;

export const RevisionOrigin = z.enum(["create", "save", "fork"]);

export const Revision = z.strictObject({
  schemaVersion: SchemaVersion,
  id: RevisionId,
  projectId: ProjectId,
  takeId: TakeId,
  /** 1-based, monotonic per take. */
  number: z.int().min(1),
  parentRevisionId: RevisionId.nullable(),
  origin: RevisionOrigin,
  manifest: TakeManifest,
  manifestHash: ContentHash,
  createdAt: Timestamp,
  createdBy: UserId,
  idempotencyKey: IdempotencyKey,
  message: z.string().max(200).nullable(),
});
export type Revision = z.infer<typeof Revision>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const SaveRevisionRequest = z
  .strictObject({
    projectId: ProjectId,
    takeId: TakeId,
    /** Head revision number the client edited from. */
    expectedRevision: z.int().min(1),
    manifest: TakeManifest,
    idempotencyKey: IdempotencyKey,
    message: z.string().max(200).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.manifest.projectId !== r.projectId)
      ctx.addIssue({ code: "custom", path: ["manifest", "projectId"], message: "manifest belongs to another project" });
    if (r.manifest.take.id !== r.takeId)
      ctx.addIssue({ code: "custom", path: ["manifest", "take", "id"], message: "manifest is for another take" });
  });
export type SaveRevisionRequest = z.infer<typeof SaveRevisionRequest>;

export const SaveRevisionResponse = z.strictObject({
  revisionId: RevisionId,
  takeId: TakeId,
  revision: z.int().min(1),
  savedAt: Timestamp,
  manifestHash: ContentHash,
  assetIds: z.array(AssetId),
});
export type SaveRevisionResponse = z.infer<typeof SaveRevisionResponse>;

/** details on a REVISION_CONFLICT error. */
export const RevisionConflictDetails = z.strictObject({
  expectedRevision: z.int(),
  currentRevision: z.int(),
  currentRevisionId: RevisionId,
});
export type RevisionConflictDetails = z.infer<typeof RevisionConflictDetails>;

/** PATCH /api/projects/[projectId]: rename a project (owner only). */
export const RenameProjectRequest = z.strictObject({ title: z.string().trim().min(1).max(120) });
export type RenameProjectRequest = z.infer<typeof RenameProjectRequest>;

export const CreateProjectRequest = z
  .strictObject({
    projectId: ProjectId,
    title: z.string().min(1).max(120),
    /** Becomes revision 1 of the original take (manifest.take.id). */
    initialManifest: TakeManifest,
    idempotencyKey: IdempotencyKey,
  })
  .superRefine((r, ctx) => {
    if (r.initialManifest.projectId !== r.projectId)
      ctx.addIssue({ code: "custom", path: ["initialManifest", "projectId"], message: "manifest belongs to another project" });
    if (r.initialManifest.take.parent !== null)
      ctx.addIssue({ code: "custom", path: ["initialManifest", "take", "parent"], message: "the original take has no parent" });
  });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const CreateProjectResponse = z.strictObject({
  project: Project,
  revision: SaveRevisionResponse,
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

export const ForkTakeRequest = z.strictObject({
  projectId: ProjectId,
  fromTakeId: TakeId,
  /** Exact revision to copy; forks never silently use a newer head. */
  fromRevision: z.int().min(1),
  newTakeId: TakeId,
  name: z.string().min(1).max(80),
  idempotencyKey: IdempotencyKey,
});
export type ForkTakeRequest = z.infer<typeof ForkTakeRequest>;

export const ForkTakeResponse = z.strictObject({
  takeId: TakeId,
  revisionId: RevisionId,
  revision: z.literal(1),
  parent: z.strictObject({ takeId: TakeId, revisionId: RevisionId }),
});
export type ForkTakeResponse = z.infer<typeof ForkTakeResponse>;

export const TakeSummary = z.strictObject({
  takeId: TakeId,
  name: z.string(),
  headRevision: z.int().min(1),
  headRevisionId: RevisionId,
  parent: z.strictObject({ takeId: TakeId, revisionId: RevisionId }).nullable(),
  updatedAt: Timestamp,
});
export type TakeSummary = z.infer<typeof TakeSummary>;

// ---------------------------------------------------------------------------
// Pure helpers shared by every implementation
// ---------------------------------------------------------------------------

/** Compare-and-swap check. */
export function checkExpectedRevision(
  head: { number: number; id: string },
  expected: number,
): Result<true> {
  if (head.number !== expected)
    return err("REVISION_CONFLICT", `take is at revision ${head.number}, not ${expected}`, {
      expectedRevision: expected,
      currentRevision: head.number,
      currentRevisionId: head.id,
    } satisfies RevisionConflictDetails);
  return ok(true);
}

/**
 * Copy a manifest into a new independent take. Assets are shared by ID
 * (immutable); everything else is a deep copy, so editing the fork can never
 * change the original.
 */
export function forkManifest(
  source: TakeManifest,
  fork: { newTakeId: string; name: string; parentRevisionId: string },
): TakeManifest {
  const copy = cloneJson(source);
  copy.take.parent = { takeId: source.take.id, revisionId: fork.parentRevisionId };
  copy.take.id = fork.newTakeId;
  copy.take.name = fork.name;
  return copy;
}

/** Every asset ID a manifest references (for INVALID_ASSET_REFERENCE checks). */
export function collectAssetIds(manifest: TakeManifest): string[] {
  const ids = new Set<string>();
  for (const o of manifest.scene.objects) {
    ids.add(o.geometry.assetId);
    if (o.geometry.originalAssetId) ids.add(o.geometry.originalAssetId);
    if (o.splat) ids.add(o.splat.assetId);
    if (o.collider?.assetId) ids.add(o.collider.assetId);
  }
  for (const t of manifest.take.tracks) {
    if (t.driver === "observed") ids.add(t.motionAssetId);
  }
  return [...ids].sort();
}
