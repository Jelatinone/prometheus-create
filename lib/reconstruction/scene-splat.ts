/**
 * Scene splat (CP-030): the room as the camera saw it, from several frames.
 *
 * fal-ai/vggt-1b reconstructs all frames of one capture together and returns a
 * fused, coloured point cloud (GLB, OpenCV camera axes: x right, y down, z
 * forward). Each point becomes one small round Gaussian in the S1 splat format
 * (binary little-endian 3DGS PLY), so the editor draws it with the Splat layer.
 * The scale is VGGT's own (not meters); the editor scales the object.
 */
import { S1_PROPERTIES } from "./splat";

export interface PointCloud {
  positions: Float32Array;
  /** RGB in 0..1, three per point. */
  colors: Float32Array;
  count: number;
}

const SH_C0 = 0.28209479177387814;

type Accessor = { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean };

/** Reads every POINTS primitive (mode 0) with POSITION (and COLOR_0 if present) from a GLB. */
export function pointsFromGlb(bytes: Uint8Array): PointCloud {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const read = (index: number): { data: Float32Array; size: number } => {
    const a: Accessor = json.accessors[index];
    const bv = json.bufferViews[a.bufferView ?? 0];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as "VEC3"] ?? 3;
    const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const width = { 5126: 4, 5121: 1, 5123: 2 }[a.componentType as 5126] ?? 4;
    const stride = bv.byteStride ?? size * width;
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < size; c++) {
        const at = base + i * stride + c * width;
        out[i * size + c] =
          a.componentType === 5126 ? view.getFloat32(at, true) : a.componentType === 5121 ? view.getUint8(at) / 255 : view.getUint16(at, true) / 65535;
      }
    return { data: out, size };
  };
  const positions: number[] = [];
  const colors: number[] = [];
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives ?? []) {
      if ((p.mode ?? 4) !== 0 || p.attributes?.POSITION === undefined) continue;
      const pos = read(p.attributes.POSITION);
      const col = p.attributes.COLOR_0 !== undefined ? read(p.attributes.COLOR_0) : null;
      const n = pos.data.length / 3;
      for (let i = 0; i < n; i++) {
        positions.push(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
        if (col) colors.push(col.data[i * col.size], col.data[i * col.size + 1], col.data[i * col.size + 2]);
        else colors.push(0.7, 0.7, 0.7);
      }
    }
  return { positions: Float32Array.from(positions), colors: Float32Array.from(colors), count: positions.length / 3 };
}

/**
 * One Gaussian per occupied voxel (averaged colour), converted to +Y up, centred
 * on the cloud and resting on y = 0. `voxel` is a fraction of the cloud's extent.
 */
export function pointsToS1Splat(
  cloud: PointCloud,
  opts: { voxelFraction?: number; flipOpenCv?: boolean; down?: [number, number, number]; levelByPlane?: boolean; targetExtent?: number } = {},
): Uint8Array {
  const { voxelFraction = 1 / 400, flipOpenCv = true, down, targetExtent } = opts;
  const level = down ? rotationTo(down, [0, 1, 0]) : opts.levelByPlane ? rotationTo(planeDown(cloud), [0, 1, 0]) : null;
  // Near-black points are letterbox bars or unlit noise, not scene surfaces.
  const keep: number[] = [];
  for (let i = 0; i < cloud.count; i++) {
    const [r, g, b] = [cloud.colors[i * 3], cloud.colors[i * 3 + 1], cloud.colors[i * 3 + 2]];
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > 0.04) keep.push(i);
  }
  // Clip the outermost 2% per axis: a few far-away points would otherwise set the scale.
  const sorted = [0, 1, 2].map((c) => keep.map((i) => cloud.positions[i * 3 + c]).sort((a, b) => a - b));
  const lo = sorted.map((v) => v[Math.floor(v.length * 0.02)] ?? 0);
  const hi = sorted.map((v) => v[Math.ceil(v.length * 0.98) - 1] ?? 0);
  const inside = keep.filter((i) => [0, 1, 2].every((c) => cloud.positions[i * 3 + c] >= lo[c] && cloud.positions[i * 3 + c] <= hi[c]));
  const n = inside.length;
  const p = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  inside.forEach((src, i) => {
    const raw: [number, number, number] = [cloud.positions[src * 3], cloud.positions[src * 3 + 1], cloud.positions[src * 3 + 2]];
    const [x, y, z] = level ? applyRotation(level, raw) : raw;
    p.set(flipOpenCv ? [x, -y, -z] : [x, y, z], i * 3);
    colors.set(cloud.colors.subarray(src * 3, src * 3 + 3), i * 3);
  });
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[i * 3 + c]); max[c] = Math.max(max[c], p[i * 3 + c]); }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const voxel = extent * voxelFraction;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(p[i * 3] / voxel)},${Math.floor(p[i * 3 + 1] / voxel)},${Math.floor(p[i * 3 + 2] / voxel)}`;
    const cell = cells.get(key);
    if (cell) for (let c = 0; c < 3; c++) { cell[c] += p[i * 3 + c]; cell[3 + c] += colors[i * 3 + c]; }
    if (cell) cell[6]++;
    else cells.set(key, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2], colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2], 1]);
  }
  const centre = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  // Optional rough size: the largest horizontal side becomes `targetExtent` (an estimate, not a measurement).
  const s = targetExtent ? targetExtent / (Math.max(max[0] - min[0], max[2] - min[2]) || 1) : 1;
  const count = cells.size;
  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n` + S1_PROPERTIES.map((name) => `property float ${name}\n`).join("") + "end_header\n";
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + count * S1_PROPERTIES.length * 4);
  out.set(head);
  const body = new DataView(out.buffer, head.length);
  const logScale = Math.log(voxel * 0.7 * s);
  const opacity = Math.log(0.92 / 0.08);
  let o = 0;
  for (const cell of cells.values()) {
    const k = cell[6];
    const values = [
      (cell[0] / k - centre[0]) * s, (cell[1] / k - centre[1]) * s, (cell[2] / k - centre[2]) * s,
      (cell[3] / k - 0.5) / SH_C0, (cell[4] / k - 0.5) / SH_C0, (cell[5] / k - 0.5) / SH_C0,
      opacity,
      logScale, logScale, logScale,
      1, 0, 0, 0,
    ];
    for (const v of values) { body.setFloat32(o, v, true); o += 4; }
  }
  return out;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rotation taking unit direction `a` onto unit direction `b` (Rodrigues). */
function rotationTo(a: [number, number, number], b: [number, number, number]): Mat3 {
  const la = Math.hypot(...a) || 1;
  const [ax, ay, az] = a.map((v) => v / la);
  const [bx, by, bz] = b;
  const v = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const c = ax * bx + ay * by + az * bz;
  if (c < -0.9999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}

function applyRotation(m: Mat3, [x, y, z]: [number, number, number]): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

/**
 * World "down" from VGGT's per-frame camera-from-world extrinsics (OpenCV: camera
 * y points down in the image). Averaging the cameras' down axes levels a hand-held
 * sweep: phones are held roughly upright while filming a room.
 */
export function worldDownFromExtrinsics(extrinsics: number[][][]): [number, number, number] {
  const sum = [0, 0, 0];
  for (const e of extrinsics) {
    // Camera axis y in world coordinates is the second row of R (R is camera-from-world).
    sum[0] += e[1][0]; sum[1] += e[1][1]; sum[2] += e[1][2];
  }
  const l = Math.hypot(...sum) || 1;
  return [sum[0] / l, sum[1] / l, sum[2] / l];
}

/**
 * "Down" for a room scan in the cloud's own (OpenCV, y-down) frame: the floor and
 * table tops dominate, so the direction of least spread is vertical. Its sign is
 * chosen so the long tail (furniture, walls) rises above the dense floor, and so
 * that it agrees with OpenCV's y-down when ambiguous.
 */
export function planeDown(cloud: PointCloud): [number, number, number] {
  const n = cloud.count;
  const step = Math.max(1, Math.floor(n / 20000));
  const mean = [0, 0, 0];
  let m = 0;
  for (let i = 0; i < n; i += step) { for (let c = 0; c < 3; c++) mean[c] += cloud.positions[i * 3 + c]; m++; }
  for (let c = 0; c < 3; c++) mean[c] /= m || 1;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i += step) {
    const d = [0, 1, 2].map((c) => cloud.positions[i * 3 + c] - mean[c]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c] += d[r] * d[c];
  }
  // Smallest eigenvector by inverse power iteration (shifted to stay well conditioned).
  const inv = invert3(cov.map((v, i) => v / (m || 1) + (i % 4 === 0 ? 1e-9 : 0)) as Mat3);
  let v: [number, number, number] = [0, 1, 0];
  for (let k = 0; k < 50; k++) {
    const w = applyRotation(inv, v);
    const l = Math.hypot(...w) || 1;
    v = [w[0] / l, w[1] / l, w[2] / l];
  }
  // VGGT puts the first camera at the origin, above the floor: down points from it towards the scene.
  return v[0] * mean[0] + v[1] * mean[1] + v[2] * mean[2] >= 0 ? v : [-v[0], -v[1], -v[2]];
}

function invert3(a: Mat3): Mat3 {
  const [p, q, r, s2, t, u, x, y, z] = a;
  const det = p * (t * z - u * y) - q * (s2 * z - u * x) + r * (s2 * y - t * x) || 1e-12;
  return [
    (t * z - u * y) / det, (r * y - q * z) / det, (q * u - r * t) / det,
    (u * x - s2 * z) / det, (p * z - r * x) / det, (r * s2 - p * u) / det,
    (s2 * y - t * x) / det, (q * x - p * y) / det, (p * t - q * s2) / det,
  ];
}
