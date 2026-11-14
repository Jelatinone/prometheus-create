/**
 * Dependency-free GLB (binary glTF 2.0) inspection and a tiny box writer.
 *
 * inspectGlb is the shared acceptance check for any mesh entering a project
 * (provider output, user import, export round-trip): file signature, chunk
 * layout, node hierarchy, triangle count and world-space bounds in the file's
 * own units. It does not decode compressed (Draco/meshopt) geometry; it flags
 * it instead.
 */
import { err, ok, type Result } from "../contracts/common";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

type Mat4 = number[]; // column-major, length 16

export interface GlbInspection {
  byteLength: number;
  generator: string | null;
  sceneCount: number;
  nodeCount: number;
  meshCount: number;
  primitiveCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  /** World-space AABB of the default scene, in file units (glTF: meters). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  dimensions: [number, number, number] | null;
  /** True if any node in the default scene carries a non-identity transform. */
  hasNodeTransforms: boolean;
  warnings: string[];
}

interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfJson {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { count?: number; min?: number[]; max?: number[] }[];
  materials?: unknown[];
  textures?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  return out;
}

/** Compose translation * rotation(xyzw) * scale, column-major. */
export function composeTrs(
  t: readonly number[] = [0, 0, 0],
  q: readonly number[] = [0, 0, 0, 1],
  s: readonly number[] = [1, 1, 1],
): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m: Mat4, p: readonly number[]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function isIdentity(m: Mat4): boolean {
  const id = identity();
  return m.every((v, i) => Math.abs(v - id[i]) < 1e-9);
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix && node.matrix.length === 16) return [...node.matrix];
  return composeTrs(node.translation, node.rotation, node.scale);
}

export function inspectGlb(input: ArrayBuffer | Uint8Array): Result<GlbInspection> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20) return err("INVALID_GEOMETRY", "file is too small to be a GLB");
  if (view.getUint32(0, true) !== GLB_MAGIC)
    return err("INVALID_GEOMETRY", "not a GLB: missing 'glTF' magic (is this a .gltf JSON or another format?)");
  const version = view.getUint32(4, true);
  if (version !== 2) return err("INVALID_GEOMETRY", `unsupported GLB container version ${version}`);
  const declared = view.getUint32(8, true);
  if (declared !== bytes.byteLength)
    return err("INVALID_GEOMETRY", `GLB header length ${declared} != file length ${bytes.byteLength} (truncated?)`);

  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) return err("INVALID_GEOMETRY", "first GLB chunk is not JSON");
  if (20 + jsonLength > bytes.byteLength) return err("INVALID_GEOMETRY", "JSON chunk overruns file");
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
  } catch {
    return err("INVALID_GEOMETRY", "GLB JSON chunk does not parse");
  }
  const binOffset = 20 + jsonLength;
  if (binOffset + 8 <= bytes.byteLength && view.getUint32(binOffset + 4, true) !== CHUNK_BIN)
    return err("INVALID_GEOMETRY", "second GLB chunk is not BIN");

  if (json.asset?.version !== "2.0")
    return err("INVALID_GEOMETRY", `asset.version is ${json.asset?.version ?? "missing"}, expected "2.0"`);

  const warnings: string[] = [];
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const extensionsRequired = json.extensionsRequired ?? [];
  for (const ext of extensionsRequired) {
    if (ext === "KHR_draco_mesh_compression" || ext === "EXT_meshopt_compression")
      warnings.push(`${ext} is required: geometry is compressed and needs a decoder`);
  }

  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  if (!scene) warnings.push("no default scene; bounds cannot be computed");

  let triangleCount = 0;
  let primitiveCount = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      primitiveCount++;
      const mode = prim.mode ?? 4;
      const count =
        prim.indices !== undefined
          ? accessors[prim.indices]?.count ?? 0
          : accessors[prim.attributes?.POSITION ?? -1]?.count ?? 0;
      if (mode === 4) triangleCount += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangleCount += Math.max(0, count - 2);
      else warnings.push(`primitive mode ${mode} is not triangles`);
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let hasNodeTransforms = false;
  let sawGeometry = false;
  const visiting = new Set<number>();

  const visit = (index: number, parent: Mat4) => {
    const node = nodes[index];
    if (!node) {
      warnings.push(`scene references missing node ${index}`);
      return;
    }
    if (visiting.has(index)) {
      warnings.push(`node cycle at ${index}`);
      return;
    }
    visiting.add(index);
    const local = nodeMatrix(node);
    if (!isIdentity(local)) hasNodeTransforms = true;
    if (node.scale?.some((v) => v <= 0)) warnings.push(`node ${index} has zero/negative scale`);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      for (const prim of meshes[node.mesh]?.primitives ?? []) {
        const acc = accessors[prim.attributes?.POSITION ?? -1];
        if (!acc?.min || !acc?.max) {
          warnings.push(`mesh ${node.mesh} POSITION accessor lacks min/max`);
          continue;
        }
        sawGeometry = true;
        for (let c = 0; c < 8; c++) {
          const corner = [
            c & 1 ? acc.max[0] : acc.min[0],
            c & 2 ? acc.max[1] : acc.min[1],
            c & 4 ? acc.max[2] : acc.min[2],
          ];
          const p = transformPoint(world, corner);
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], p[i]);
            max[i] = Math.max(max[i], p[i]);
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
    visiting.delete(index);
  };
  for (const root of scene?.nodes ?? []) visit(root, identity());

  if (meshes.length === 0) warnings.push("file contains no meshes");
  const bounds = sawGeometry ? { min, max } : null;
  const dimensions = bounds
    ? ([max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number])
    : null;
  if (dimensions) {
    const longest = Math.max(...dimensions);
    if (longest > 50) warnings.push(`longest side is ${longest.toFixed(2)} units; source may be in cm/mm`);
    if (longest > 0 && longest < 0.01) warnings.push(`longest side is ${longest} units; scale is suspiciously small`);
  }

  return ok({
    byteLength: bytes.byteLength,
    generator: json.asset?.generator ?? null,
    sceneCount: json.scenes?.length ?? 0,
    nodeCount: nodes.length,
    meshCount: meshes.length,
    primitiveCount,
    triangleCount,
    materialCount: json.materials?.length ?? 0,
    textureCount: json.textures?.length ?? 0,
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired,
    bounds,
    dimensions,
    hasNodeTransforms,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// Minimal writer: an axis-aligned box mesh, used for fixtures and tests.
// ---------------------------------------------------------------------------

export interface BoxGlbOptions {
  /** Full extents in meters [x, y, z]. */
  size: [number, number, number];
  /** Linear RGBA base color. */
  color?: [number, number, number, number];
  /** Optional node TRS (applied by viewers, not baked). */
  node?: { translation?: number[]; rotation?: number[]; scale?: number[] };
  generator?: string;
  name?: string;
}

/** Build a valid GLB containing one box (24 vertices, 12 triangles). */
export function buildBoxGlb(options: BoxGlbOptions): Uint8Array {
  const [sx, sy, sz] = options.size.map((v) => v / 2);
  // Each face: normal + 4 corners (counter-clockwise seen from outside).
  const faces: { n: number[]; c: number[][] }[] = [
    { n: [1, 0, 0], c: [[sx, -sy, sz], [sx, -sy, -sz], [sx, sy, -sz], [sx, sy, sz]] },
    { n: [-1, 0, 0], c: [[-sx, -sy, -sz], [-sx, -sy, sz], [-sx, sy, sz], [-sx, sy, -sz]] },
    { n: [0, 1, 0], c: [[-sx, sy, sz], [sx, sy, sz], [sx, sy, -sz], [-sx, sy, -sz]] },
    { n: [0, -1, 0], c: [[-sx, -sy, -sz], [sx, -sy, -sz], [sx, -sy, sz], [-sx, -sy, sz]] },
    { n: [0, 0, 1], c: [[-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]] },
    { n: [0, 0, -1], c: [[sx, -sy, -sz], [-sx, -sy, -sz], [-sx, sy, -sz], [sx, sy, -sz]] },
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);
  faces.forEach((face, f) => {
    face.c.forEach((corner, k) => {
      positions.set(corner, (f * 4 + k) * 3);
      normals.set(face.n, (f * 4 + k) * 3);
    });
    const b = f * 4;
    indices.set([b, b + 1, b + 2, b, b + 2, b + 3], f * 6);
  });

  const posBytes = positions.byteLength; // 288
  const nrmBytes = normals.byteLength; // 288
  const idxBytes = indices.byteLength; // 72
  const binLength = posBytes + nrmBytes + idxBytes; // multiple of 4
  const bin = new Uint8Array(binLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(normals.buffer), posBytes);
  bin.set(new Uint8Array(indices.buffer), posBytes + nrmBytes);

  const node: Record<string, unknown> = { mesh: 0, name: options.name ?? "box" };
  if (options.node?.translation) node.translation = options.node.translation;
  if (options.node?.rotation) node.rotation = options.node.rotation;
  if (options.node?.scale) node.scale = options.node.scale;

  const gltf = {
    asset: { version: "2.0", generator: options.generator ?? "prometheus-create buildBoxGlb" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [
      {
        name: options.name ?? "box",
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: "box",
        pbrMetallicRoughness: {
          baseColorFactor: options.color ?? [0.8, 0.45, 0.2, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
      },
    ],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-sx, -sy, -sz], max: [sx, sy, sz] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };

  let jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = Math.ceil(jsonBytes.byteLength / 4) * 4;
  if (jsonPadded !== jsonBytes.byteLength) {
    const padded = new Uint8Array(jsonPadded).fill(0x20); // pad JSON with spaces
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.byteLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.byteLength;
  view.setUint32(binHeader, binLength, true);
  view.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(bin, binHeader + 8);
  return out;
}
