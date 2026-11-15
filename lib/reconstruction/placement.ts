/**
 * Scene placement of reconstructed objects from the provider's own pose
 * (HK-011 CP-009). Measured, not assumed:
 *
 * - fal-ai/sam-3/3d-objects `metadata[i]` gives scale, rotation and translation
 *   of object i in the frame's camera space. The rotation is a quaternion in
 *   [w, x, y, z] order applied as its TRANSPOSE: posed = s * R(q)^T * p + t,
 *   where p is the object-local splat (Z-up) frame. Fit on the round table:
 *   0.049 mm mean residual over its 839,808 Gaussians.
 * - The camera frame is PyTorch3D-style (+X left, +Y up, +Z forward). The
 *   canonical scene frame (+X right, +Y up, viewer at +Z) is a 180° turn about Y.
 *
 * Every single-mask job on the same frame is posed in that frame's camera, so
 * objects from separate jobs can be laid out relative to each other. Each job
 * estimates depth/scale on its own, so cross-job consistency is approximate.
 * Placement is provider-inferred; dimensions remain "estimated".
 */
import { err, ok, type Result, type Vec3 } from "@/lib/contracts";
import { PROVIDER_SPLAT_TO_GLB, composeTransforms, quatMultiply, rotateVec, type QuatXYZW, type SplatTransform } from "./splat";

/** Canonical scene from provider camera: 180° about Y, (x, y, z) -> (-x, y, -z). */
export const PROVIDER_CAMERA_TO_SCENE: QuatXYZW = [0, 1, 0, 0];

export interface ProviderObjectPose {
  objectIndex: number;
  /** Uniform scale (the provider reports three equal factors). */
  scale: number;
  /** As reported: [w, x, y, z]. */
  rotationWxyz: [number, number, number, number];
  translation: Vec3;
}

/**
 * Transform for the object's normalized mesh / S1 splat space into the shared
 * scene frame (glTF order: p' = position + rotation * (scale * p)).
 */
export interface ScenePlacement {
  frame: "provider_camera";
  position: Vec3;
  rotation: QuatXYZW;
  scale: number;
  /** The object's +Y (its up) in the scene frame. */
  up: Vec3;
}

const conj = ([x, y, z, w]: QuatXYZW): QuatXYZW => [-x, -y, -z, w];
const normalizeQuat = (q: QuatXYZW): QuatXYZW => {
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** First row of a value the provider may batch as [[...]]. */
function row(value: unknown, length: number): number[] | null {
  const r = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(r) && r.length === length && r.every((v) => typeof v === "number" && Number.isFinite(v)) ? (r as number[]) : null;
}

/** Parse `output.metadata` (array) or a bundle `metadata.json` (`{ objects: [...] }`). */
export function parseProviderMetadata(raw: unknown): Result<ProviderObjectPose[]> {
  const list = Array.isArray(raw) ? raw : (raw as { objects?: unknown })?.objects;
  if (!Array.isArray(list) || list.length === 0) return err("INVALID_SCHEMA", "provider metadata has no objects");
  const poses: ProviderObjectPose[] = [];
  for (const [i, entry] of list.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const scale = row(e.scale, 3);
    const rotation = row(e.rotation, 4);
    const translation = row(e.translation, 3);
    if (!scale || !rotation || !translation) return err("INVALID_SCHEMA", `provider metadata object ${i} lacks scale/rotation/translation`);
    const [a, b, c] = scale;
    if (!(a > 0) || Math.max(a, b, c) / Math.min(a, b, c) > 1.001)
      return err("INVALID_SCHEMA", `provider metadata object ${i} has a non-uniform or invalid scale; placement unsupported`);
    if (!(Math.hypot(...rotation) > 0)) return err("INVALID_SCHEMA", `provider metadata object ${i} has a zero rotation`);
    poses.push({
      objectIndex: typeof e.object_index === "number" ? e.object_index : i,
      scale: (a + b + c) / 3,
      rotationWxyz: rotation as [number, number, number, number],
      translation: translation as Vec3,
    });
  }
  return ok(poses);
}

/** Inverse of p' = t + R(s p). */
export function invertTransform(t: SplatTransform): SplatTransform {
  const r = conj(t.rotation);
  const s = 1 / t.scale;
  const back = rotateVec(r, t.translation);
  return { rotation: r, scale: s, translation: [-s * back[0], -s * back[1], -s * back[2]] };
}

/**
 * Placement of one object: scene <- camera <- provider pose <- splat frame <-
 * GLB frame <- normalized space (inverse of normalizeGlb's root transform).
 */
export function objectPlacement(pose: ProviderObjectPose, rootTransform: SplatTransform): ScenePlacement {
  const [w, x, y, z] = pose.rotationWxyz;
  const posed: SplatTransform = { translation: pose.translation, rotation: conj(normalizeQuat([x, y, z, w])), scale: pose.scale };
  const chain = [
    { translation: [0, 0, 0] as Vec3, rotation: PROVIDER_CAMERA_TO_SCENE, scale: 1 },
    posed,
    { translation: [0, 0, 0] as Vec3, rotation: conj(PROVIDER_SPLAT_TO_GLB), scale: 1 },
    invertTransform(rootTransform),
  ];
  const t = chain.reduceRight((inner, outer) => composeTransforms(outer, inner));
  const rotation = normalizeQuat(t.rotation);
  return { frame: "provider_camera", position: t.translation, rotation, scale: t.scale, up: rotateVec(rotation, [0, 1, 0]) };
}

/** Shortest-arc rotation taking unit vector u onto unit vector v. */
function rotationBetween(u: Vec3, v: Vec3): QuatXYZW {
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (d < -1 + 1e-9) return Math.abs(u[0]) < 0.9 ? normalizeQuat([0, -u[2], u[1], 0]) : normalizeQuat([u[2], 0, -u[0], 0]);
  return normalizeQuat([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0], 1 + d]);
}

/**
 * Level a set of objects reconstructed from ONE frame: rotate all of them
 * together about the camera so their mean up is +Y, then drop them so the
 * lowest base rests on y = 0. Relative positions and orientations are
 * preserved; the camera stays at x = z = 0. Assumes reconstructed objects are
 * upright in their own frame (true for the observed SAM 3D outputs).
 */
export function levelPlacements(placements: ScenePlacement[]): ScenePlacement[] {
  if (placements.length === 0) return [];
  const sum = placements.reduce<Vec3>((a, p) => [a[0] + p.up[0], a[1] + p.up[1], a[2] + p.up[2]], [0, 0, 0]);
  const len = Math.hypot(...sum);
  const level = len > 1e-9 ? rotationBetween([sum[0] / len, sum[1] / len, sum[2] / len], [0, 1, 0]) : ([0, 0, 0, 1] as QuatXYZW);
  const turned = placements.map((p) => {
    const rotation = normalizeQuat(quatMultiply(level, p.rotation));
    return { ...p, position: rotateVec(level, p.position), rotation, up: rotateVec(rotation, [0, 1, 0]) };
  });
  const floor = Math.min(...turned.map((p) => p.position[1]));
  return turned.map((p) => ({ ...p, position: [p.position[0], p.position[1] - floor, p.position[2]] as Vec3 }));
}
