import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoxGlb, inspectGlb } from "@/lib/assets/glb";
import { NORMALIZATION_NODE_NAME, checkMeshGlb, normalizeGlb } from "@/lib/reconstruction";

const AXIS_BOX = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../../public/fixtures/axis-box.glb")));

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("normalizeGlb", () => {
  it("keeps a meters/+Y file's dimensions and rests it on y = 0, centered in x/z", () => {
    const n = ok(normalizeGlb(AXIS_BOX, { sourceUnits: "m", sourceUpAxis: "+Y" }));
    close(n.inspection.dimensions!, [0.4, 0.9, 0.2]);
    close(n.localBounds.min, [-0.2, 0, -0.1]);
    close(n.localBounds.max, [0.2, 0.9, 0.1]);
    close(n.recenterOffset, [0, -0.45, 0]);
    expect(n.normalization).toEqual({ sourceUnits: "m", sourceUpAxis: "+Y", scaleApplied: 1, nodeTransformsBaked: false });
  });

  it("converts a Z-up centimeter file to meters and +Y without touching the binary chunk", () => {
    // 40 cm wide, 20 cm deep (Y), 90 cm tall (Z) in a Z-up file.
    const zUpCm = buildBoxGlb({ size: [40, 20, 90] });
    const n = ok(normalizeGlb(zUpCm, { sourceUnits: "cm", sourceUpAxis: "+Z" }));
    close(n.inspection.dimensions!, [0.4, 0.9, 0.2]);
    expect(n.localBounds.min[1]).toBeCloseTo(0, 6);
    expect(n.normalization.scaleApplied).toBe(0.01);
    expect(n.inspection.hasNodeTransforms).toBe(true);

    // The BIN chunk (vertex data) is byte-identical: only the JSON changed.
    const tail = (b: Uint8Array) => b.subarray(20 + new DataView(b.buffer, b.byteOffset).getUint32(12, true));
    expect(Buffer.from(tail(n.bytes)).equals(Buffer.from(tail(zUpCm)))).toBe(true);

    const json = JSON.parse(new TextDecoder().decode(n.bytes.subarray(20, 20 + new DataView(n.bytes.buffer).getUint32(12, true))));
    const root = json.nodes[json.scenes[0].nodes[0]];
    expect(root.name).toBe(NORMALIZATION_NODE_NAME);
    expect(root.scale).toEqual([0.01, 0.01, 0.01]);
  });

  it("composes with existing node transforms (provider placed the mesh off-origin)", () => {
    const offset = buildBoxGlb({ size: [0.4, 0.9, 0.2], node: { translation: [3, 1, -2] } });
    const n = ok(normalizeGlb(offset, { sourceUnits: "unknown", sourceUpAxis: "unknown" }));
    close(n.inspection.dimensions!, [0.4, 0.9, 0.2]);
    close(n.localBounds.min, [-0.2, 0, -0.1]);
    close(n.recenterOffset, [3, 0.55, -2]);
    expect(n.normalization).toMatchObject({ sourceUnits: "unknown", sourceUpAxis: "unknown", scaleApplied: 1 });
    expect(ok(inspectGlb(n.bytes)).warnings).toEqual([]);
  });

  it("rejects non-GLB bytes, truncated files and mesh-less GLBs as INVALID_GEOMETRY", () => {
    const bad = (bytes: Uint8Array) => {
      const r = normalizeGlb(bytes, { sourceUnits: "m", sourceUpAxis: "+Y" });
      return r.ok ? "ok" : r.error.code;
    };
    expect(bad(new TextEncoder().encode("not a mesh"))).toBe("INVALID_GEOMETRY");
    expect(bad(AXIS_BOX.subarray(0, AXIS_BOX.byteLength - 8))).toBe("INVALID_GEOMETRY");

    const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0 }) + "  ");
    const glb = new Uint8Array(20 + json.byteLength);
    const v = new DataView(glb.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, glb.byteLength, true);
    v.setUint32(12, json.byteLength, true);
    v.setUint32(16, 0x4e4f534a, true);
    glb.set(json, 20);
    expect(bad(glb)).toBe("INVALID_GEOMETRY");
    const r = checkMeshGlb(glb);
    expect(!r.ok && r.error.message).toContain("no triangle mesh");
  });
});
