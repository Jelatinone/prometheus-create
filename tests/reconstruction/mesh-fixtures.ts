/**
 * Synthetic GLBs for the CP-010 simplifier: a gently curved n x n grid
 * (2·n² triangles) shaped like provider output (indexed triangles, POSITION +
 * normalized RGBA COLOR_0), with optional UVs, an embedded image and layouts
 * the simplifier must refuse.
 */
export interface GridOptions {
  n: number;
  /** Side length in meters (default 1). */
  size?: number;
  colors?: boolean;
  uvs?: boolean;
  /** Bytes of an embedded image (kept verbatim by the simplifier). */
  image?: Uint8Array;
  /** Extra glTF fields merged into the JSON (e.g. animations) to build refused layouts. */
  extraJson?: Record<string, unknown>;
  /** Extra vertex attribute name (refused unless supported), filled with zeros as float VEC4. */
  extraAttribute?: string;
  /** Omit indices (refused). */
  nonIndexed?: boolean;
  /** Root node TRS, like normalizeGlb's wrapper. */
  root?: { translation?: number[]; rotation?: number[]; scale?: number[] };
}

export function gridSurface(x: number, z: number): number {
  return 0.02 * Math.sin(x * 6) * Math.cos(z * 6);
}

export function buildGridGlb(o: GridOptions): Uint8Array {
  const size = o.size ?? 1;
  const n = o.n;
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Uint8Array(verts * 4);
  const uv = new Float32Array(verts * 2);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const v = j * (n + 1) + i;
      const x = (i / n - 0.5) * size;
      const z = (j / n - 0.5) * size;
      pos.set([x, gridSurface(x, z) + 0.05, z], v * 3);
      col.set([Math.round((255 * i) / n), Math.round((255 * j) / n), 128, 255], v * 4);
      uv.set([i / n, j / n], v * 2);
    }
  const idx = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      idx.set([a, c, b, b, c, d], k);
      k += 6;
    }

  const chunks: Uint8Array[] = [];
  const views: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (bytes: Uint8Array) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    const padded = Math.ceil(bytes.byteLength / 4) * 4;
    const chunk = new Uint8Array(padded);
    chunk.set(bytes);
    chunks.push(chunk);
    offset += padded;
    return views.length - 1;
  };
  const accessor = (a: Record<string, unknown>) => accessors.push(a) - 1;
  const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < verts; v++)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], pos[v * 3 + c]);
      max[c] = Math.max(max[c], pos[v * 3 + c]);
    }
  [min, max] = [min.map(Math.fround), max.map(Math.fround)];
  const attributes: Record<string, number> = {
    POSITION: accessor({ bufferView: view(bytes(pos)), componentType: 5126, count: verts, type: "VEC3", min, max }),
  };
  if (o.colors ?? true) attributes.COLOR_0 = accessor({ bufferView: view(col), componentType: 5121, normalized: true, count: verts, type: "VEC4" });
  if (o.uvs) attributes.TEXCOORD_0 = accessor({ bufferView: view(bytes(uv)), componentType: 5126, count: verts, type: "VEC2" });
  if (o.extraAttribute)
    attributes[o.extraAttribute] = accessor({ bufferView: view(new Uint8Array(verts * 16)), componentType: 5126, count: verts, type: "VEC4" });
  const primitive: Record<string, unknown> = { attributes, mode: 4 };
  if (!o.nonIndexed) primitive.indices = accessor({ bufferView: view(bytes(idx)), componentType: 5125, count: idx.length, type: "SCALAR" });
  if (o.image) primitive.material = 0;

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "prometheus-create test grid" },
    scene: 0,
    scenes: [{ nodes: [1] }],
    nodes: [{ mesh: 0, name: "grid" }, { name: "root", children: [0], ...(o.root ?? {}) }],
    meshes: [{ name: "grid", primitives: [primitive] }],
    accessors,
    bufferViews: views,
    ...(o.image
      ? {
          images: [{ bufferView: view(o.image), mimeType: "image/png" }],
          textures: [{ source: 0 }],
          materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        }
      : {}),
    ...(o.extraJson ?? {}),
  };
  json.buffers = [{ byteLength: offset }];

  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4;
  const total = 28 + jsonLength + offset;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  glb.set(encoded, 20);
  glb.fill(0x20, 20 + encoded.byteLength, 20 + jsonLength);
  dv.setUint32(20 + jsonLength, offset, true);
  dv.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const c of chunks) {
    glb.set(c, at);
    at += c.byteLength;
  }
  return glb;
}

/** The JSON chunk of a GLB. */
export function glbJson(glb: Uint8Array): Record<string, any> {
  const length = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}
