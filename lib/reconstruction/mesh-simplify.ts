/**
 * Simplify a GLB's triangle meshes for interactive preview (CP-010).
 *
 * The node tree (including the normalization root), materials, textures and
 * images are kept as they are; only indexed triangle primitives are rewritten,
 * with meshoptimizer's attribute-aware simplifier. The source GLB is never
 * modified: the result is a separate file meant to be stored as a derivative.
 * Layouts this module does not understand are reported, never guessed at.
 */
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { err, ok, type Result } from "@/lib/contracts";
import { checkMeshGlb } from "./glb-normalize";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const TRIANGLES = 4;
const UNUSED = 0xffffffff;

/** Attributes the simplifier keeps, with their weight in the appearance error. */
const ATTRIBUTE_WEIGHTS: Record<string, number> = { NORMAL: 0.5, COLOR_0: 1, TEXCOORD_0: 1 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export interface SimplifyOptions {
  /** Total triangle budget across all primitives. */
  targetTriangles: number;
  /** Relative error limit (fraction of the mesh extent). Default 1e-3. */
  targetError?: number;
  /** Skip when the result keeps more than this fraction of the triangles. Default 0.8. */
  minReduction?: number;
}

export type SimplifyOutcome =
  | {
      status: "simplified";
      bytes: Uint8Array;
      triangles: number;
      sourceTriangles: number;
      vertices: number;
      /** meshoptimizer's relative appearance error (largest over primitives); an algorithm metric, not a visual guarantee. */
      error: number;
    }
  | { status: "skipped"; reason: string; sourceTriangles: number };

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  targets?: unknown[];
  [key: string]: unknown;
}
interface Gltf {
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  buffers?: { byteLength: number; uri?: string }[];
  meshes?: { primitives: Primitive[] }[];
  images?: { bufferView?: number; uri?: string }[];
  animations?: unknown[];
  skins?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

function parse(bytes: Uint8Array): Result<{ json: Gltf; bin: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) return err("INVALID_GEOMETRY", "not a GLB");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.byteLength) return err("INVALID_GEOMETRY", "GLB JSON chunk is malformed");
  let json: Gltf;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
  } catch {
    return err("INVALID_GEOMETRY", "GLB JSON chunk does not parse");
  }
  const binStart = 20 + jsonLength;
  if (binStart + 8 > bytes.byteLength) return ok({ json, bin: new Uint8Array(0) });
  const binLength = view.getUint32(binStart, true);
  if (view.getUint32(binStart + 4, true) !== CHUNK_BIN || binStart + 8 + binLength > bytes.byteLength)
    return err("INVALID_GEOMETRY", "GLB BIN chunk is malformed");
  return ok({ json, bin: bytes.subarray(binStart + 8, binStart + 8 + binLength) });
}

/** Typed access to one accessor's elements inside the BIN chunk. */
class AccessorReader {
  readonly components: number;
  readonly elementBytes: number;
  private readonly base: number;
  private readonly stride: number;
  private readonly view: DataView;

  constructor(
    readonly accessor: Accessor,
    bufferView: BufferView,
    private readonly bin: Uint8Array,
  ) {
    this.components = COMPONENTS[accessor.type];
    this.elementBytes = this.components * COMPONENT_BYTES[accessor.componentType];
    this.base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    this.stride = bufferView.byteStride ?? this.elementBytes;
    this.view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  }

  inBounds(): boolean {
    return this.accessor.count === 0 || this.base + this.stride * (this.accessor.count - 1) + this.elementBytes <= this.bin.byteLength;
  }

  element(i: number): Uint8Array {
    const start = this.base + this.stride * i;
    return this.bin.subarray(start, start + this.elementBytes);
  }

  /** Component c of element i as a float (normalized integers mapped to [0,1] / [-1,1]). */
  float(i: number, c: number): number {
    const size = COMPONENT_BYTES[this.accessor.componentType];
    const at = this.base + this.stride * i + c * size;
    const n = this.accessor.normalized;
    switch (this.accessor.componentType) {
      case 5126:
        return this.view.getFloat32(at, true);
      case 5121:
        return n ? this.view.getUint8(at) / 255 : this.view.getUint8(at);
      case 5123:
        return n ? this.view.getUint16(at, true) / 65535 : this.view.getUint16(at, true);
      case 5120:
        return n ? Math.max(this.view.getInt8(at) / 127, -1) : this.view.getInt8(at);
      case 5122:
        return n ? Math.max(this.view.getInt16(at, true) / 32767, -1) : this.view.getInt16(at, true);
      default:
        return this.view.getUint32(at, true);
    }
  }
}

function unsupported(reason: string): Result<never> {
  return err("UNSUPPORTED_MEDIA", `mesh layout not supported for simplification: ${reason}`);
}

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

/**
 * Simplify every triangle primitive of `bytes` to share `targetTriangles`.
 * Returns `skipped` (with the reason) when the mesh is already within budget
 * or simplification would not reduce it meaningfully; an error when the GLB
 * is malformed or uses a layout this module does not rewrite.
 */
export async function simplifyGlb(bytes: Uint8Array, options: SimplifyOptions): Promise<Result<SimplifyOutcome>> {
  const checked = checkMeshGlb(bytes);
  if (!checked.ok) return checked;
  const parsed = parse(bytes);
  if (!parsed.ok) return parsed;
  const { json, bin } = parsed.value;

  if (json.animations?.length || json.skins?.length) return unsupported("animations or skins");
  if (json.extensionsRequired?.length) return unsupported(`required extensions ${json.extensionsRequired.join(", ")}`);
  if (json.extensionsUsed?.includes("EXT_mesh_gpu_instancing")) return unsupported("GPU instancing");
  if ((json.buffers?.length ?? 0) !== 1 || json.buffers![0].uri !== undefined) return unsupported("expected exactly one embedded buffer");
  const accessors = json.accessors ?? [];
  const views = json.bufferViews ?? [];
  const reader = (index: number | undefined): AccessorReader | null => {
    const a = index === undefined ? undefined : accessors[index];
    if (!a || a.sparse || a.bufferView === undefined || !views[a.bufferView] || views[a.bufferView].buffer !== 0) return null;
    if (!COMPONENTS[a.type] || !COMPONENT_BYTES[a.componentType]) return null;
    const r = new AccessorReader(a, views[a.bufferView], bin);
    return r.inBounds() ? r : null;
  };

  // Validate every primitive before doing any work.
  const primitives: Primitive[] = (json.meshes ?? []).flatMap((m) => m.primitives ?? []);
  let sourceTriangles = 0;
  for (const p of primitives) {
    if ((p.mode ?? TRIANGLES) !== TRIANGLES) return unsupported("non-triangle primitive");
    if (p.targets?.length) return unsupported("morph targets");
    if (p.indices === undefined) return unsupported("non-indexed primitive");
    for (const name of Object.keys(p.attributes)) if (name !== "POSITION" && !(name in ATTRIBUTE_WEIGHTS)) return unsupported(`attribute ${name}`);
    const pos = reader(p.attributes.POSITION);
    if (!pos || pos.accessor.componentType !== 5126 || pos.accessor.type !== "VEC3") return unsupported("POSITION must be float VEC3");
    const idx = reader(p.indices);
    if (!idx || idx.accessor.type !== "SCALAR" || ![5121, 5123, 5125].includes(idx.accessor.componentType) || idx.accessor.count % 3)
      return unsupported("indices must be unsigned scalar triangles");
    for (const name of Object.keys(ATTRIBUTE_WEIGHTS))
      if (p.attributes[name] !== undefined) {
        const a = reader(p.attributes[name]);
        if (!a || a.accessor.count !== pos.accessor.count) return unsupported(`${name} does not match POSITION`);
      }
    sourceTriangles += idx.accessor.count / 3;
  }
  if (options.targetTriangles >= sourceTriangles)
    return ok({ status: "skipped", reason: `${sourceTriangles} triangles is within the ${options.targetTriangles} budget`, sourceTriangles });

  await MeshoptSimplifier.ready;
  const out = structuredClone(json);
  const newAccessors: Accessor[] = [];
  const newViews: BufferView[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pushView = (data: Uint8Array): number => {
    newViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    chunks.push(data);
    const padded = align4(data.byteLength);
    if (padded !== data.byteLength) chunks.push(new Uint8Array(padded - data.byteLength));
    offset += padded;
    return newViews.length - 1;
  };

  let triangles = 0;
  let vertices = 0;
  let maxError = 0;
  const outPrimitives: Primitive[] = (out.meshes ?? []).flatMap((m) => m.primitives ?? []);
  for (let k = 0; k < primitives.length; k++) {
    const p = primitives[k];
    const idx = reader(p.indices)!;
    const pos = reader(p.attributes.POSITION)!;
    const count = pos.accessor.count;
    const indices = new Uint32Array(idx.accessor.count);
    for (let i = 0; i < indices.length; i++) indices[i] = idx.float(i, 0);
    if (indices.some((i) => i >= count)) return unsupported("index out of range");
    const positions = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) for (let c = 0; c < 3; c++) positions[v * 3 + c] = pos.float(v, c);

    const weighted = Object.keys(ATTRIBUTE_WEIGHTS)
      .filter((name) => p.attributes[name] !== undefined)
      .map((name) => ({ name, r: reader(p.attributes[name])! }));
    const stride = weighted.reduce((n, a) => n + a.r.components, 0);
    const weights = weighted.flatMap((a) => Array<number>(a.r.components).fill(ATTRIBUTE_WEIGHTS[a.name]));
    const share = Math.max(1, Math.floor((options.targetTriangles * (indices.length / 3)) / sourceTriangles));
    const targetError = options.targetError ?? 1e-3;
    let simplified: Uint32Array;
    let error: number;
    if (stride) {
      const attrs = new Float32Array(count * stride);
      for (let v = 0; v < count; v++) {
        let o = v * stride;
        for (const a of weighted) for (let c = 0; c < a.r.components; c++) attrs[o++] = a.r.float(v, c);
      }
      [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attrs, stride, weights, null, share * 3, targetError, ["LockBorder"]);
    } else {
      [simplified, error] = MeshoptSimplifier.simplify(indices, positions, 3, share * 3, targetError, ["LockBorder"]);
    }
    // compactMesh rewrites `simplified` in place to the new, dense vertex numbering.
    const [remap, unique] = MeshoptSimplifier.compactMesh(simplified);
    maxError = Math.max(maxError, error);
    triangles += simplified.length / 3;
    vertices += unique;

    const target = outPrimitives[k];
    const attributes: Record<string, number> = {};
    for (const name of Object.keys(p.attributes)) {
      const r = reader(p.attributes[name])!;
      const data = new Uint8Array(unique * r.elementBytes);
      for (let old = 0; old < remap.length; old++) if (remap[old] !== UNUSED) data.set(r.element(old), remap[old] * r.elementBytes);
      const accessor: Accessor = { bufferView: pushView(data), componentType: r.accessor.componentType, count: unique, type: r.accessor.type };
      if (r.accessor.normalized) accessor.normalized = true;
      if (name === "POSITION") {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let old = 0; old < remap.length; old++)
          if (remap[old] !== UNUSED)
            for (let c = 0; c < 3; c++) {
              min[c] = Math.min(min[c], positions[old * 3 + c]);
              max[c] = Math.max(max[c], positions[old * 3 + c]);
            }
        accessor.min = min;
        accessor.max = max;
      }
      newAccessors.push(accessor);
      attributes[name] = newAccessors.length - 1;
    }
    const wide = unique > 0xffff;
    const indexData = wide ? simplified : Uint16Array.from(simplified);
    newAccessors.push({
      bufferView: pushView(new Uint8Array(indexData.buffer, indexData.byteOffset, indexData.byteLength)),
      componentType: wide ? 5125 : 5123,
      count: simplified.length,
      type: "SCALAR",
    });
    target.attributes = attributes;
    target.indices = newAccessors.length - 1;
  }

  // Images embedded in the buffer keep their bytes (textures are not resampled).
  for (const image of out.images ?? []) {
    if (image.bufferView === undefined) continue;
    const v = views[image.bufferView];
    if (!v || v.buffer !== 0 || (v.byteOffset ?? 0) + v.byteLength > bin.byteLength) return unsupported("image bufferView out of range");
    image.bufferView = pushView(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  }
  out.accessors = newAccessors;
  out.bufferViews = newViews;
  out.buffers = [{ byteLength: offset }];

  const glb = writeGlb(out, chunks, offset);
  const verified = checkMeshGlb(glb);
  if (!verified.ok) return verified;
  if (verified.value.triangleCount !== triangles) return err("INVALID_GEOMETRY", "simplified GLB triangle count does not match");
  if (triangles > sourceTriangles * (options.minReduction ?? 0.8))
    return ok({ status: "skipped", reason: `simplification kept ${triangles} of ${sourceTriangles} triangles`, sourceTriangles });
  return ok({ status: "simplified", bytes: glb, triangles, sourceTriangles, vertices, error: maxError });
}

function writeGlb(json: unknown, chunks: Uint8Array[], binLength: number): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(encoded.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  glb.set(encoded, 20);
  glb.fill(0x20, 20 + encoded.byteLength, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, CHUNK_BIN, true);
  let at = 28 + jsonLength;
  for (const c of chunks) {
    glb.set(c, at);
    at += c.byteLength;
  }
  return glb;
}
