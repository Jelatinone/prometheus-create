import { err, ok, type Observation, type Result, type SceneObject, type TakeManifest } from "@/lib/contracts";
import type { ReconstructionOutcome } from "@/lib/reconstruction/runner";

/** Explicit acceptance adds one object to the take that requested it, never replaces geometry. */
export function reconstructedObject(manifest: TakeManifest, takeId: string, name: string, observation: Observation, outcome: ReconstructionOutcome): Result<SceneObject> {
  if (manifest.take.id !== takeId || manifest.projectId !== outcome.job.projectId || observation.projectId !== manifest.projectId)
    return err("STALE_REVISION", "switch back to the take that requested this reconstruction before adding it");
  if (outcome.job.state !== "succeeded" || !outcome.apply.apply || !outcome.geometry || outcome.job.input.observationId !== observation.id)
    return err("INVALID_GEOMETRY", "this job has no applicable mesh");
  const id = `obj_${outcome.job.id.slice(4)}`;
  if (manifest.scene.objects.some(o => o.id === id)) return err("DUPLICATE", "this reconstruction is already in the take");
  return ok({
    id, name: name.trim().slice(0, 80) || "Reconstructed object", geometry: outcome.geometry,
    material: { mode: "embedded" },
    transform: { position: [0, -outcome.geometry.localBounds.min[1], 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true, dimensionsStatus: "estimated",
    provenance: { kind: "generated", sourceIds: [observation.sourceId], observationIds: [observation.id], jobId: outcome.job.id, provider: outcome.job.providerModel, note: "Estimated geometry from one captured view; hidden surfaces and scale are inferred." },
    splat: null, collider: null, physics: null,
  });
}
