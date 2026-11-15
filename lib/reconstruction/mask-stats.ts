/**
 * Coverage statistics of a provider mask (HK-011 CP-022): how much of the
 * frame the object fills, its bounding box, and whether it is cut off by the
 * frame edge. Decodes the non-interlaced 8-bit PNGs fal-ai/sam-3/image
 * returns (greyscale, observed) plus grey+alpha, RGB and RGBA; anything else
 * yields null rather than a guess. Uses the web DecompressionStream, so it
 * runs in Node and browsers.
 */

export interface MaskStats {
  assetId: string;
  /** Fraction of frame pixels inside the mask, 0..1. */
  areaFraction: number;
  /** Normalized [x0, y0, x1, y1] (0..1, inclusive pixel edges), or null when empty. */
  box: [number, number, number, number] | null;
  /** True when the mask reaches any frame edge (the object may be cut off). */
  touchesEdge: boolean;
  /** Provider confidence when known (only on the finishing response). */
  score: number | null;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode to one "inside" bit per pixel (first channel > 127, and alpha > 0 when present). */
export async function decodeMask(png: Uint8Array): Promise<{ width: number; height: number; inside: Uint8Array } | null> {
  if (png.byteLength < 33 || SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.byteLength; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = CHANNELS[colorType] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) return null;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || !channels || !idat.length) return null;
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of idat) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(joined);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.byteLength < height * (stride + 1)) return null;
  const inside = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      cur[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : NaN) & 0xff;
      if (filter > 4) return null;
    }
    for (let x = 0; x < width; x++) {
      const p = x * channels;
      const alpha = channels === 2 ? cur[p + 1] : channels === 4 ? cur[p + 3] : 255;
      inside[y * width + x] = cur[p] > 127 && alpha > 0 ? 1 : 0;
    }
    prev = cur;
  }
  return { width, height, inside };
}

/** Coverage of one mask PNG, or null when it cannot be decoded. */
export async function maskStats(assetId: string, png: Uint8Array, score: number | null = null): Promise<MaskStats | null> {
  const decoded = await decodeMask(png);
  if (!decoded) return null;
  const { width, height, inside } = decoded;
  let count = 0;
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (inside[y * width + x]) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (!count) return { assetId, areaFraction: 0, box: null, touchesEdge: false, score };
  return {
    assetId,
    areaFraction: count / (width * height),
    box: [x0 / width, y0 / height, (x1 + 1) / width, (y1 + 1) / height],
    touchesEdge: x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1,
    score,
  };
}
