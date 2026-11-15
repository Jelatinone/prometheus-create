/**
 * Provider Gaussian splats -> S1 splat assets (PLAN v4 seam S1).
 *
 * S1: a binary little-endian 3DGS PLY whose centres, rotations and scales are
 * in the SAME object-local canonical space as the normalized mesh (meters,
 * +Y up, after `normalizeGlb`'s root transform). Viewers put it under the
 * object's transform and apply no further normalization.
 *
 * Provider frame (measured, HK-011 CP-007): fal-ai/sam-3/3d-objects returns a
 * per-object `object_NN/splat.ply` inside `artifacts_zip` that is the object in
 * a Z-up version of the GLB frame: GLB (x, y, z) = splat (x, z, -y). The
 * top-level `gaussian_splat` is posed into the camera frame and is NOT used.
 * Splats are inferred appearance (hidden surfaces included), never measured depth.
 */
import { err, ok, type Result, type Vec3 } from "@/lib/contracts";

export type QuatXYZW = [number, number, number, number];

/** Media type stored for S1 splat assets. */
export const SPLAT_MIME = "model/ply";

/** Object-store cap per asset (lib/server/storage.ts MAX_OBJECT_BYTES = Supabase bucket fileSizeLimit). */
export const SPLAT_MAX_BYTES = 50 * 1024 * 1024;

/** Provider splat frame -> provider GLB frame: -90° about X, (x, y, z) -> (x, z, -y). */
export const PROVIDER_SPLAT_TO_GLB: QuatXYZW = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** Properties written to S1 files, in order (3DGS layout; rot_0 is the real part w). */
export const S1_PROPERTIES = [
  "x", "y", "z",
  "f_dc_0", "f_dc_1", "f_dc_2",
  "opacity",
  "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
] as const;

/** Logit of alpha = 1/255: anything fainter cannot change an 8-bit pixel. */
const INVISIBLE_OPACITY_LOGIT = Math.log(1 / 254);
const MAX_HEADER_BYTES = 64 * 1024;

export interface SplatPly {
  count: number;
  properties: string[];
  /** Byte stride of one vertex record. */
  stride: number;
  /** View over the vertex records (starts right after end_header). */
  body: DataView;
}

/** Parse and structurally validate a binary little-endian Gaussian-splat PLY. */
export function parseSplatPly(bytes: Uint8Array): Result<SplatPly> {
  const limit = Math.min(bytes.byteLength, MAX_HEADER_BYTES);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, limit));
  const end = head.indexOf("end_header\n");
  if (!head.startsWith("ply\n") || end < 0) return err("INVALID_GEOMETRY", "splat is not a PLY file (missing ply/end_header)");
  const lines = head.slice(0, end).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("comment") && !l.startsWith("obj_info"));
  if (lines[1] !== "format binary_little_endian 1.0") return err("INVALID_GEOMETRY", `unsupported PLY format: ${lines[1] ?? "none"}`);
  let count = -1;
  const properties: string[] = [];
  for (const line of lines.slice(2)) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      if (count >= 0 || parts[1] !== "vertex") return err("INVALID_GEOMETRY", `unsupported PLY element "${parts[1]}" (expected one vertex element)`);
      count = Number(parts[2]);
      if (!Number.isSafeInteger(count) || count <= 0) return err("INVALID_GEOMETRY", "PLY vertex count is missing or zero");
    } else if (parts[0] === "property") {
      if (count < 0) return err("INVALID_GEOMETRY", "PLY property before its element");
      if (parts[1] !== "float" && parts[1] !== "float32") return err("INVALID_GEOMETRY", `PLY property ${parts.at(-1)} is ${parts[1]}; only float properties are supported`);
      properties.push(parts[2]);
    } else return err("INVALID_GEOMETRY", `unexpected PLY header line: ${line.slice(0, 60)}`);
  }
  const missing = S1_PROPERTIES.filter((p) => !properties.includes(p));
  if (missing.length) return err("INVALID_GEOMETRY", `PLY is not a Gaussian splat; missing ${missing.join(", ")}`);
  const start = end + "end_header\n".length;
  const stride = properties.length * 4;
  if (bytes.byteLength - start < count * stride)
    return err("INVALID_GEOMETRY", `PLY body is truncated: ${bytes.byteLength - start} bytes for ${count} × ${stride}`);
  return ok({ count, properties, stride, body: new DataView(bytes.buffer, bytes.byteOffset + start, count * stride) });
}

/** p' = translation + rotation * (scale * p), as in a glTF node. */
export interface SplatTransform {
  translation: Vec3;
  rotation: QuatXYZW;
  scale: number;
}

export interface S1Splat {
  bytes: Uint8Array;
  count: number;
  /** Splats removed because a value was not finite. */
  droppedInvalid: number;
  /** Splats removed because alpha < 1/255 (no visible effect). */
  droppedInvisible: number;
  /** Faintest splats removed only to fit the storage cap (visible loss; reported). */
  droppedForSize: number;
  /** Bounds of the written centres in object-local canonical space. */
  centreBounds: { min: Vec3; max: Vec3 };
}

/** Hamilton product a ⊗ b, both [x, y, z, w]. */
export function quatMultiply(a: QuatXYZW, b: QuatXYZW): QuatXYZW {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function rotateVec(q: QuatXYZW, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Compose `outer` after `inner` (both p' = t + R(s p)). */
export function composeTransforms(outer: SplatTransform, inner: SplatTransform): SplatTransform {
  const t = rotateVec(outer.rotation, inner.translation);
  return {
    translation: [outer.translation[0] + outer.scale * t[0], outer.translation[1] + outer.scale * t[1], outer.translation[2] + outer.scale * t[2]],
    rotation: quatMultiply(outer.rotation, inner.rotation),
    scale: outer.scale * inner.scale,
  };
}

function s1Header(count: number): Uint8Array {
  const lines = [
    "ply",
    "format binary_little_endian 1.0",
    "comment prometheus S1 splat: object-local canonical space (meters, +Y up); inferred by provider, not measured depth",
    `element vertex ${count}`,
    ...S1_PROPERTIES.map((p) => `property float ${p}`),
    "end_header",
    "",
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * Re-express a provider splat in S1 space with `transform` (provider frame ->
 * normalized mesh space), drop normals and other extra properties, drop
 * invisible splats, and, only if still above `maxBytes`, the faintest ones.
 */
export function toS1Splat(ply: SplatPly, transform: SplatTransform, maxBytes = SPLAT_MAX_BYTES): Result<S1Splat> {
  if (!(transform.scale > 0) || !Number.isFinite(transform.scale)) return err("INVALID_GEOMETRY", "splat transform scale must be positive");
  const at = Object.fromEntries(S1_PROPERTIES.map((p) => [p, ply.properties.indexOf(p) * 4])) as Record<(typeof S1_PROPERTIES)[number], number>;
  const n = ply.count;
  const opacity = new Float32Array(n);
  const keep = new Uint8Array(n);
  let droppedInvalid = 0;
  let droppedInvisible = 0;
  for (let i = 0; i < n; i++) {
    const base = i * ply.stride;
    let finite = true;
    for (const p of S1_PROPERTIES) if (!Number.isFinite(ply.body.getFloat32(base + at[p], true))) finite = false;
    if (!finite) {
      droppedInvalid++;
      continue;
    }
    opacity[i] = ply.body.getFloat32(base + at.opacity, true);
    if (opacity[i] < INVISIBLE_OPACITY_LOGIT) {
      droppedInvisible++;
      continue;
    }
    keep[i] = 1;
  }
  let kept = n - droppedInvalid - droppedInvisible;
  const record = S1_PROPERTIES.length * 4;
  const capacity = Math.floor((maxBytes - s1Header(n).byteLength) / record);
  let droppedForSize = 0;
  if (kept > capacity) {
    const order = Array.from({ length: n }, (_, i) => i).filter((i) => keep[i]).sort((a, b) => opacity[a] - opacity[b]);
    droppedForSize = kept - Math.max(0, capacity);
    for (let k = 0; k < droppedForSize; k++) keep[order[k]] = 0;
    kept -= droppedForSize;
  }
  if (kept === 0) return err("INVALID_GEOMETRY", "splat has no usable Gaussians after validation");

  const header = s1Header(kept);
  const out = new Uint8Array(header.byteLength + kept * record);
  out.set(header);
  const view = new DataView(out.buffer, header.byteLength);
  const { translation: t, rotation: R, scale: s } = transform;
  const logS = Math.log(s);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const base = i * ply.stride;
    const get = (p: (typeof S1_PROPERTIES)[number]) => ply.body.getFloat32(base + at[p], true);
    const r = rotateVec(R, [get("x"), get("y"), get("z")]);
    const c: Vec3 = [t[0] + s * r[0], t[1] + s * r[1], t[2] + s * r[2]];
    // 3DGS stores (w, x, y, z); compose the frame rotation on the left.
    const q = quatMultiply(R, [get("rot_1"), get("rot_2"), get("rot_3"), get("rot_0")]);
    const values: Record<(typeof S1_PROPERTIES)[number], number> = {
      x: c[0], y: c[1], z: c[2],
      f_dc_0: get("f_dc_0"), f_dc_1: get("f_dc_1"), f_dc_2: get("f_dc_2"),
      opacity: get("opacity"),
      scale_0: get("scale_0") + logS, scale_1: get("scale_1") + logS, scale_2: get("scale_2") + logS,
      rot_0: q[3], rot_1: q[0], rot_2: q[1], rot_3: q[2],
    };
    for (const p of S1_PROPERTIES) {
      view.setFloat32(o, values[p], true);
      o += 4;
    }
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], c[a]);
      max[a] = Math.max(max[a], c[a]);
    }
  }
  return ok({ bytes: out, count: kept, droppedInvalid, droppedInvisible, droppedForSize, centreBounds: { min, max } });
}

/** Bundle entry holding object `index`'s object-local splat. */
export function bundleSplatPath(index: number): string {
  return `object_${String(index).padStart(2, "0")}/splat.ply`;
}
