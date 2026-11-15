/**
 * Normalize a provider GLB into canonical object space (right-handed, meters,
 * +Y up) without touching its binary buffer.
 *
 * The default scene's roots are wrapped in one new root node whose TRS applies
 * the unit scale, the up-axis conversion and a recentering offset. Vertices
 * are not rewritten, so `nodeTransformsBaked` is false: viewers must honor the
 * node hierarchy (every glTF loader does), and nothing may apply it twice.
 * The recentering offset is returned so the editor can place the object where
 * the provider put it.
 */
import { err, ok, type Geometry, type Result, type Vec3 } from "@/lib/contracts";
import { inspectGlb, type GlbInspection } from "@/lib/assets/glb";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
export const NORMALIZATION_NODE_NAME = "prometheus_normalization";

export type SourceUnits = Geometry["normalization"]["sourceUnits"];
export type SourceUpAxis = Geometry["normalization"]["sourceUpAxis"];

export interface NormalizeOptions {
  /** Units of the incoming file. "unknown" keeps file units (glTF says meters) with scale 1. */
  sourceUnits: SourceUnits;
  /** Up axis of the incoming file. "unknown" applies no rotation. */
  sourceUpAxis: SourceUpAxis;
  /** Where the object-space origin goes. Default: bottom center (rests on y = 0). */
  recenter?: "bottom_center" | "center" | "none";
}

export interface NormalizedGlb {
  bytes: Uint8Array;
  /** Inspection of the incoming file (file units and axes). */
  original: GlbInspection;
  /** Inspection after normalization: canonical meters, +Y up. */
  inspection: GlbInspection;
  normalization: Geometry["normalization"];
  localBounds: Geometry["localBounds"];
  /** Canonical-space translation removed by recentering. Placing the object at this position restores the provider layout. */
  recenterOffset: Vec3;
}

const UNIT_SCALE: Record<SourceUnits, number> = { m: 1, cm: 0.01, mm: 0.001, unknown: 1 };

/** Rotation taking the source up axis to +Y (right-handed; +Z up -> -90° about X). */
const UP_ROTATION: Record<SourceUpAxis, [number, number, number, number]> = {
  "+Y": [0, 0, 0, 1],
  unknown: [0, 0, 0, 1],
  "+Z": [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
};

/** Map a source-space point through the up-axis rotation (exact for 90° steps). */
function rotateUp(axis: SourceUpAxis, [x, y, z]: Vec3): Vec3 {
  return axis === "+Z" ? [x, z, -y] : [x, y, z];
}

interface ParsedGlb {
  json: Record<string, unknown> & { scene?: number; scenes?: { nodes?: number[] }[]; nodes?: Record<string, unknown>[] };
  rest: Uint8Array; // everything after the JSON chunk (BIN chunk etc.), untouched
}

function parseGlb(bytes: Uint8Array): Result<ParsedGlb> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) return err("INVALID_GEOMETRY", "not a GLB");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.byteLength)
    return err("INVALID_GEOMETRY", "GLB JSON chunk is malformed");
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as ParsedGlb["json"];
    return ok({ json, rest: bytes.subarray(20 + jsonLength) });
  } catch {
    return err("INVALID_GEOMETRY", "GLB JSON chunk does not parse");
  }
}

function writeGlb(json: unknown, rest: Uint8Array): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(jsonBytes.byteLength / 4) * 4;
  if (padded !== jsonBytes.byteLength) {
    const p = new Uint8Array(padded).fill(0x20);
    p.set(jsonBytes);
    jsonBytes = p;
  }
  const total = 20 + jsonBytes.byteLength + rest.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.byteLength);
  return out;
}

/** Validate a GLB as a usable mesh: parses, has triangles and finite bounds. */
export function checkMeshGlb(bytes: Uint8Array): Result<GlbInspection> {
  const inspected = inspectGlb(bytes);
  if (!inspected.ok) return inspected;
  const v = inspected.value;
  if (v.meshCount === 0 || v.triangleCount === 0) return err("INVALID_GEOMETRY", "GLB contains no triangle mesh");
  if (!v.bounds || !v.dimensions) return err("INVALID_GEOMETRY", "GLB bounds cannot be computed (missing POSITION min/max?)");
  if (!v.dimensions.every((d) => Number.isFinite(d)) || Math.max(...v.dimensions) <= 0)
    return err("INVALID_GEOMETRY", "GLB has degenerate or non-finite bounds");
  const blocking = v.extensionsRequired.filter((e) => e === "KHR_draco_mesh_compression" || e === "EXT_meshopt_compression");
  if (blocking.length) return err("INVALID_GEOMETRY", `compressed geometry is not supported yet: ${blocking.join(", ")}`);
  return ok(v);
}

export function normalizeGlb(bytes: Uint8Array, options: NormalizeOptions): Result<NormalizedGlb> {
  const original = checkMeshGlb(bytes);
  if (!original.ok) return original;
  const parsed = parseGlb(bytes);
  if (!parsed.ok) return parsed;
  const { json, rest } = parsed.value;

  const scale = UNIT_SCALE[options.sourceUnits];
  const rotation = UP_ROTATION[options.sourceUpAxis];
  const { min, max } = original.value.bounds!;
  // Bounds after scale + rotation (exact: rotation is a 90° step).
  const a = rotateUp(options.sourceUpAxis, [min[0] * scale, min[1] * scale, min[2] * scale]);
  const b = rotateUp(options.sourceUpAxis, [max[0] * scale, max[1] * scale, max[2] * scale]);
  const lo: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const hi: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const mode = options.recenter ?? "bottom_center";
  const anchor: Vec3 =
    mode === "none"
      ? [0, 0, 0]
      : [(lo[0] + hi[0]) / 2, mode === "bottom_center" ? lo[1] : (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const translation: Vec3 = [-anchor[0], -anchor[1], -anchor[2]];

  const sceneIndex = json.scene ?? 0;
  const scenes = json.scenes ?? [];
  const scene = scenes[sceneIndex];
  if (!scene) return err("INVALID_GEOMETRY", "GLB has no default scene to normalize");
  const nodes = [...(json.nodes ?? [])];
  const rootIndex = nodes.length;
  const root: Record<string, unknown> = { name: NORMALIZATION_NODE_NAME, children: [...(scene.nodes ?? [])] };
  if (translation.some((t) => t !== 0)) root.translation = translation.map((t) => (Object.is(t, -0) ? 0 : t));
  if (rotation[3] !== 1) root.rotation = rotation;
  if (scale !== 1) root.scale = [scale, scale, scale];
  nodes.push(root);
  const nextScenes = scenes.map((s, i) => (i === sceneIndex ? { ...s, nodes: [rootIndex] } : s));
  const out = writeGlb({ ...json, nodes, scenes: nextScenes }, rest);

  const inspection = checkMeshGlb(out);
  if (!inspection.ok) return inspection;
  const bounds = inspection.value.bounds!;
  return ok({
    bytes: out,
    original: original.value,
    inspection: inspection.value,
    normalization: {
      sourceUnits: options.sourceUnits,
      sourceUpAxis: options.sourceUpAxis,
      scaleApplied: scale,
      nodeTransformsBaked: false,
    },
    localBounds: { min: bounds.min, max: bounds.max },
    recenterOffset: anchor,
  });
}
