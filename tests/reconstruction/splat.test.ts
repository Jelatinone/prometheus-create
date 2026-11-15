import { describe, expect, it } from "vitest";
import {
  PROVIDER_SPLAT_TO_GLB,
  S1_PROPERTIES,
  composeTransforms,
  parseSplatPly,
  quatMultiply,
  rotateVec,
  toS1Splat,
  type QuatXYZW,
} from "@/lib/reconstruction";
import { expectOk } from "../capture/helpers";
import { buildSplatPly, readS1 } from "./splat-fixtures";

const IDENTITY = { translation: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as QuatXYZW, scale: 1 };
const close = (a: number[], b: number[], eps = 1e-5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe("parseSplatPly", () => {
  it("accepts the provider layout (17 floats with normals) and finds every 3DGS property", () => {
    const ply = expectOk(parseSplatPly(buildSplatPly([{ p: [0, 0, 0] }], { withNormals: true })));
    expect(ply.count).toBe(1);
    expect(ply.stride).toBe(17 * 4);
    for (const p of S1_PROPERTIES) expect(ply.properties).toContain(p);
  });

  it("rejects non-PLY, ASCII, non-splat and truncated files", () => {
    expect(parseSplatPly(new TextEncoder().encode("glTF....")).ok).toBe(false);
    const ascii = new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n");
    expect(parseSplatPly(ascii).ok).toBe(false);
    const pointCloud = new TextEncoder().encode("ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n");
    const r = parseSplatPly(new Uint8Array([...pointCloud, ...new Uint8Array(12)]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/missing f_dc_0/);
    const full = buildSplatPly([{ p: [0, 0, 0] }, { p: [1, 1, 1] }]);
    expect(parseSplatPly(full.subarray(0, full.byteLength - 4)).ok).toBe(false);
  });
});

describe("splat transforms", () => {
  it("maps the provider Z-up splat frame onto the GLB frame: (x, y, z) -> (x, z, -y)", () => {
    close(rotateVec(PROVIDER_SPLAT_TO_GLB, [1, 2, 3]), [1, 3, -2]);
  });

  it("composes like glTF nodes: outer(inner(p))", () => {
    const inner = { translation: [1, 0, 0] as [number, number, number], rotation: PROVIDER_SPLAT_TO_GLB, scale: 2 };
    const outer = { translation: [0, 5, 0] as [number, number, number], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as QuatXYZW, scale: 3 };
    const both = composeTransforms(outer, inner);
    const apply = (t: typeof inner, p: [number, number, number]) => {
      const r = rotateVec(t.rotation, [p[0] * t.scale, p[1] * t.scale, p[2] * t.scale]);
      return [t.translation[0] + r[0], t.translation[1] + r[1], t.translation[2] + r[2]] as [number, number, number];
    };
    close(apply(both, [0.3, -0.7, 1.1]), apply(outer, apply(inner, [0.3, -0.7, 1.1])));
  });

  it("re-expresses centres, rotations and log-scales, and drops normals", () => {
    const src = buildSplatPly([{ p: [0, 0, 1], scale: [Math.log(0.1), Math.log(0.2), Math.log(0.3)], rot: [1, 0, 0, 0] }], { withNormals: true });
    const t = composeTransforms({ translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 2 }, { ...IDENTITY, rotation: PROVIDER_SPLAT_TO_GLB });
    const s1 = expectOk(toS1Splat(expectOk(parseSplatPly(src)), t));
    const [g] = readS1(s1.bytes);
    // (0,0,1) -> rotate -> (0,1,0) -> scale 2 -> (0,2,0) -> translate -> (1,4,3)
    close([g.x, g.y, g.z], [1, 4, 3]);
    close([g.scale_0, g.scale_1, g.scale_2], [Math.log(0.2), Math.log(0.4), Math.log(0.6)]);
    // Identity Gaussian rotation becomes the frame rotation (stored w, x, y, z).
    const q = PROVIDER_SPLAT_TO_GLB;
    close([g.rot_0, g.rot_1, g.rot_2, g.rot_3], [q[3], q[0], q[1], q[2]]);
    expect(new TextDecoder().decode(s1.bytes.subarray(0, 400))).not.toMatch(/property float nx/);
    const headerLength = new TextDecoder("latin1").decode(s1.bytes).indexOf("end_header\n") + "end_header\n".length;
    expect(s1.bytes.byteLength - headerLength).toBe(S1_PROPERTIES.length * 4);
  });

  it("keeps each Gaussian's own rotation, composing the frame on the left", () => {
    const own: QuatXYZW = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    const src = buildSplatPly([{ p: [0, 0, 0], rot: [own[3], own[0], own[1], own[2]] }]);
    const [g] = readS1(expectOk(toS1Splat(expectOk(parseSplatPly(src)), { ...IDENTITY, rotation: PROVIDER_SPLAT_TO_GLB })).bytes);
    const want = quatMultiply(PROVIDER_SPLAT_TO_GLB, own);
    close([g.rot_1, g.rot_2, g.rot_3, g.rot_0], want);
  });
});

describe("toS1Splat pruning", () => {
  it("drops invisible and non-finite Gaussians, reporting counts", () => {
    const src = buildSplatPly([{ p: [0, 0, 0] }, { p: [1, 0, 0], opacity: -9 }, { p: [Number.NaN, 0, 0] }]);
    const s1 = expectOk(toS1Splat(expectOk(parseSplatPly(src)), IDENTITY));
    expect([s1.count, s1.droppedInvisible, s1.droppedInvalid, s1.droppedForSize]).toEqual([1, 1, 1, 0]);
    expect(readS1(s1.bytes)).toHaveLength(1);
  });

  it("drops only the faintest Gaussians when the file would exceed the cap", () => {
    const gaussians = Array.from({ length: 10 }, (_, i) => ({ p: [i, 0, 0] as [number, number, number], opacity: i }));
    const src = buildSplatPly(gaussians);
    const record = S1_PROPERTIES.length * 4;
    const s1 = expectOk(toS1Splat(expectOk(parseSplatPly(src)), IDENTITY, 400 + 6 * record));
    expect(s1.droppedForSize).toBeGreaterThan(0);
    expect(s1.bytes.byteLength).toBeLessThanOrEqual(400 + 6 * record);
    const kept = readS1(s1.bytes).map((g) => g.opacity);
    expect(Math.min(...kept)).toBe(10 - s1.count);
  });

  it("refuses a splat with nothing usable", () => {
    const src = buildSplatPly([{ p: [0, 0, 0], opacity: -20 }]);
    expect(toS1Splat(expectOk(parseSplatPly(src)), IDENTITY).ok).toBe(false);
  });
});
