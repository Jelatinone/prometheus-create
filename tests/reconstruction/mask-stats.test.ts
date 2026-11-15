/**
 * HK-011 CP-022: mask coverage from provider PNG masks (8-bit greyscale,
 * non-interlaced, as fal-ai/sam-3/image returns them).
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeMask, maskStats } from "@/lib/reconstruction";

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(out.subarray(4, 8 + body.byteLength)));
  return out;
}

/** Encode pixels (channels per pixel) as a PNG, using each row's filter from `filters` in turn. */
function png(width: number, height: number, pixels: Uint8Array, colorType = 0, filters = [0]): Uint8Array {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]!;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c;
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][f];
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A width x height grey mask with the rectangle [x0, x1) x [y0, y1) set to 255. */
function rect(width: number, height: number, [x0, y0, x1, y1]: number[]): Uint8Array {
  const px = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * width + x] = 255;
  return px;
}

describe("mask coverage", () => {
  it("measures area, box and edge contact of an interior object under every PNG filter", async () => {
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      const stats = await maskStats("ast_m", png(40, 20, rect(40, 20, [10, 5, 30, 15]), 0, filters), 0.9);
      expect(stats, `filters ${filters}`).toEqual({ assetId: "ast_m", areaFraction: 200 / 800, box: [0.25, 0.25, 0.75, 0.75], touchesEdge: false, score: 0.9 });
    }
  });

  it("flags an object cut off by the frame edge", async () => {
    const stats = await maskStats("ast_m", png(40, 20, rect(40, 20, [0, 5, 10, 15])));
    expect(stats).toMatchObject({ areaFraction: 100 / 800, touchesEdge: true, score: null });
  });

  it("reports an empty mask as zero coverage with no box", async () => {
    expect(await maskStats("ast_m", png(8, 8, new Uint8Array(64)))).toEqual({ assetId: "ast_m", areaFraction: 0, box: null, touchesEdge: false, score: null });
  });

  it("reads RGBA masks by the first channel and alpha", async () => {
    const px = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) px.set(i < 4 ? [255, 255, 255, 255] : i < 8 ? [255, 255, 255, 0] : [0, 0, 0, 255], i * 4);
    const decoded = await decodeMask(png(4, 4, px, 6, [4]));
    expect(Array.from(decoded!.inside)).toEqual([1, 1, 1, 1, ...Array(12).fill(0)]);
  });

  it("returns null for what it does not decode instead of guessing", async () => {
    expect(await decodeMask(new Uint8Array([1, 2, 3]))).toBeNull();
    const sixteenBit = png(4, 4, new Uint8Array(16));
    sixteenBit[24] = 16; // IHDR bit depth
    expect(await decodeMask(sixteenBit)).toBeNull();
  });
});
