/**
 * S1 splat assets (PLAN v4): binary little-endian 3DGS PLY whose centres,
 * scales and rotations are already in the object-local space of the
 * normalized mesh. The editor applies no extra normalization; this module only
 * decides whether bytes are a usable splat before the renderer sees them.
 */
import type { SceneObject } from "@/lib/contracts/scene";

/** Properties every 3DGS PLY must carry (extra properties are allowed). */
export const REQUIRED_SPLAT_PROPERTIES = [
  "x", "y", "z",
  "f_dc_0", "f_dc_1", "f_dc_2",
  "opacity",
  "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
] as const;

const TYPE_BYTES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

export interface SplatPlyInfo {
  vertexCount: number;
  properties: string[];
  headerBytes: number;
  strideBytes: number;
}

export type SplatCheck = { ok: true; info: SplatPlyInfo } | { ok: false; reason: string };

/** Validates a 3DGS PLY header and that the body holds every declared vertex. */
export function checkSplatPly(bytes: Uint8Array): SplatCheck {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  if (!head.startsWith("ply\n") && !head.startsWith("ply\r\n")) return { ok: false, reason: "not a PLY file" };
  const end = head.indexOf("end_header");
  if (end < 0) return { ok: false, reason: "PLY header has no end_header" };
  const newline = head.indexOf("\n", end);
  if (newline < 0) return { ok: false, reason: "PLY header is truncated" };
  const lines = head.slice(0, end).split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes("format binary_little_endian 1.0")) return { ok: false, reason: "PLY must be binary_little_endian 1.0" };

  let vertexCount = -1;
  let inVertex = false;
  let stride = 0;
  const properties: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      inVertex = parts[1] === "vertex";
      if (inVertex) vertexCount = Number(parts[2]);
      else if (vertexCount >= 0) break; // only the vertex element is read
    } else if (parts[0] === "property" && inVertex) {
      if (parts[1] === "list") return { ok: false, reason: "vertex list properties are not supported" };
      const size = TYPE_BYTES[parts[1]];
      if (!size) return { ok: false, reason: `unknown PLY type ${parts[1]}` };
      stride += size;
      properties.push(parts[2]);
    }
  }
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) return { ok: false, reason: "PLY has no vertices" };
  const missing = REQUIRED_SPLAT_PROPERTIES.filter((p) => !properties.includes(p));
  if (missing.length) return { ok: false, reason: `not a 3DGS splat: missing ${missing.join(", ")}` };
  const headerBytes = newline + 1;
  if (bytes.length < headerBytes + vertexCount * stride) return { ok: false, reason: "PLY body is shorter than its header declares" };
  return { ok: true, info: { vertexCount, properties, headerBytes, strideBytes: stride } };
}

export type SplatLayerState = "none" | "stale" | "available";

/** Whether an object can show a splat: attached and still matching its geometry revision. */
export function splatState(object: SceneObject): SplatLayerState {
  if (!object.splat) return "none";
  return object.splat.validForGeometryRevision === object.geometry.geometryRevision ? "available" : "stale";
}

/** Whether this object can draw on the splat layer: any valid splat. The Layers menu alone decides what is shown. */
export function wantsSplat(object: SceneObject): boolean {
  return splatState(object) === "available";
}

/** Which layers the viewport draws. View state only: never saved with the take (ADR-005). */
export interface LayerView {
  mesh: boolean;
  splat: boolean;
}

export const ALL_LAYERS: LayerView = { mesh: true, splat: true };

/** ADR-005: an object draws its splat when the Splat layer is on and the object opts in. Its mesh follows the Mesh layer alone. */
export function drawsSplat(object: SceneObject, layers: LayerView): boolean {
  return layers.splat && wantsSplat(object);
}
