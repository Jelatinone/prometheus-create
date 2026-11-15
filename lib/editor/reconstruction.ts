import { err, ok, type Asset, type Observation, type Result, type SceneObject, type TakeManifest } from "@/lib/contracts";
import type { ReconstructionOutcome } from "@/lib/reconstruction/runner";

/**
 * S2/S3 (PLAN v4): Track A adds `splatAsset: Asset | null` to ReconstructionOutcome.
 * Read it structurally until then, so this attach works before and after that lands.
 */
type OutcomeWithSplat = ReconstructionOutcome & { splatAsset?: Asset | null };

/** S3 attach: the provider splat rides on the object, off by default, valid for this geometry revision. */
export function attachedSplat(outcome: OutcomeWithSplat, geometryRevision: number): SceneObject["splat"] {
  const asset = outcome.splatAsset;
  if (!asset || asset.kind !== "splat" || asset.projectId !== outcome.job.projectId) return null;
  return { assetId: asset.id, enabled: false, validForGeometryRevision: geometryRevision };
}

/**
 * Where a reconstructed object goes in the scene. Track A's `outcome.placement`
 * (CP-009) is in the provider camera frame; levelled with `levelPlacements()`
 * across the objects of one frame it becomes this shape (structural, so this
 * file does not depend on Track A's module before the merge).
 */
export interface LevelledPlacement {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: number;
}

/** Explicit acceptance adds one object to the take that requested it, never replaces geometry. */
export function reconstructedObject(
  manifest: TakeManifest,
  takeId: string,
  name: string,
  observation: Observation,
  outcome: ReconstructionOutcome,
  placement: LevelledPlacement | null = null,
): Result<SceneObject> {
  if (manifest.take.id !== takeId || manifest.projectId !== outcome.job.projectId || observation.projectId !== manifest.projectId)
    return err("STALE_REVISION", "switch back to the take that requested this reconstruction before adding it");
  if (outcome.job.state !== "succeeded" || !outcome.apply.apply || !outcome.geometry || outcome.job.input.observationId !== observation.id)
    return err("INVALID_GEOMETRY", "this job has no applicable mesh");
  const id = `obj_${outcome.job.id.slice(4)}`;
  if (manifest.scene.objects.some(o => o.id === id)) return err("DUPLICATE", "this reconstruction is already in the take");
  return ok({
    id, name: name.trim().slice(0, 80) || "Reconstructed object", geometry: outcome.geometry,
    material: { mode: "embedded" },
    // With a placement, the provider's pose (camera-relative, levelled) keeps objects from one frame in their
    // captured layout; without one, the object stands on the floor at the origin.
    transform: placement && Number.isFinite(placement.scale) && placement.scale > 0
      ? { position: placement.position, rotation: placement.rotation, scale: [placement.scale, placement.scale, placement.scale] }
      : { position: [0, -outcome.geometry.localBounds.min[1], 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true, dimensionsStatus: "estimated",
    provenance: { kind: "generated", sourceIds: [observation.sourceId], observationIds: [observation.id], jobId: outcome.job.id, provider: outcome.job.providerModel, note: "Estimated geometry from one captured view; hidden surfaces and scale are inferred." },
    splat: attachedSplat(outcome, outcome.geometry.geometryRevision), collider: null, physics: null,
  });
}

/**
 * CP-014: the splat that `attach_splat` returns for an object's own generation
 * job, attached and shown. Refused unless the backfill proves it belongs to
 * this exact mesh (its `meshAsset` is the object's geometry asset), so a splat
 * is never shown against a mesh it was not aligned with.
 */
export function providerSplatFor(object: SceneObject, outcome: ReconstructionOutcome): Result<NonNullable<SceneObject["splat"]>> {
  if (outcome.job.state !== "succeeded") return err("INVALID_TRANSITION", "the splat job has not finished");
  const splat = (outcome as OutcomeWithSplat).splatAsset;
  if (!splat || splat.kind !== "splat") return err("MISSING_ASSET", "this generation has no stored splat");
  if (outcome.job.projectId !== splat.projectId) return err("NOT_FOUND", "the splat belongs to another project");
  if (!outcome.meshAsset || outcome.meshAsset.id !== object.geometry.assetId)
    return err("STALE_REVISION", "the stored splat belongs to a different mesh than this object's; the mesh stays");
  return ok({ assetId: splat.id, enabled: true, validForGeometryRevision: object.geometry.geometryRevision });
}
