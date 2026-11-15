/**
 * CP-010: GLB simplification for the cached mesh preview. Synthetic grids
 * only; the real round-table comparison is recorded in docs/changes/HK-011.md.
 */
import { describe, expect, it } from "vitest";
import { inspectGlb } from "@/lib/assets/glb";
import { normalizeGlb, simplifyGlb } from "@/lib/reconstruction";
import { expectOk } from "../capture/helpers";
import { buildGridGlb, glbJson } from "./mesh-fixtures";

const inspect = (glb: Uint8Array) => expectOk(inspectGlb(glb));

describe("simplifyGlb", () => {
  it("reduces a dense coloured mesh to the budget with the same bounds, node tree and attribute formats", async () => {
    const source = buildGridGlb({ n: 100, root: { translation: [0.5, 0, -0.25] } }); // 20,000 triangles
    const out = expectOk(await simplifyGlb(source, { targetTriangles: 2_000, targetError: 0.05 }));
    if (out.status !== "simplified") throw new Error(out.reason);
    expect(out.sourceTriangles).toBe(20_000);
    expect(out.triangles).toBeLessThanOrEqual(2_000);
    expect(out.triangles).toBeGreaterThan(1_000);
    const before = inspect(source);
    const after = inspect(out.bytes);
    expect(after.triangleCount).toBe(out.triangles);
    // Borders are locked, so the footprint (and the world bounds through the root node) is unchanged.
    for (const axis of [0, 2]) {
      expect(after.bounds!.min[axis]).toBeCloseTo(before.bounds!.min[axis], 6);
      expect(after.bounds!.max[axis]).toBeCloseTo(before.bounds!.max[axis], 6);
    }
    for (const axis of [0, 1, 2]) expect(Math.abs(after.bounds!.max[axis] - before.bounds!.max[axis])).toBeLessThan(0.01);
    const [a, b] = [glbJson(source), glbJson(out.bytes)];
    expect(b.nodes).toEqual(a.nodes);
    expect(b.scenes).toEqual(a.scenes);
    expect(b.asset).toEqual(a.asset);
    const prim = b.meshes[0].primitives[0];
    expect(Object.keys(prim.attributes).sort()).toEqual(["COLOR_0", "POSITION"]);
    expect(b.accessors[prim.attributes.COLOR_0]).toMatchObject({ componentType: 5121, normalized: true, type: "VEC4", count: out.vertices });
    expect(b.accessors[prim.indices]).toMatchObject({ componentType: 5123, count: out.triangles * 3 });
    expect(out.bytes.byteLength).toBeLessThan(source.byteLength / 5);
  });

  it("keeps UVs, materials and embedded image bytes verbatim", async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const source = buildGridGlb({ n: 60, uvs: true, image });
    const out = expectOk(await simplifyGlb(source, { targetTriangles: 1_000, targetError: 0.05 }));
    if (out.status !== "simplified") throw new Error(out.reason);
    const json = glbJson(out.bytes);
    expect(json.materials).toEqual(glbJson(source).materials);
    expect(json.meshes[0].primitives[0].material).toBe(0);
    expect(json.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined();
    const view = json.bufferViews[json.images[0].bufferView];
    const jsonLength = new DataView(out.bytes.buffer, out.bytes.byteOffset).getUint32(12, true);
    const bin = out.bytes.subarray(28 + jsonLength);
    expect(Array.from(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength))).toEqual(Array.from(image));
  });

  it("keeps a normalized GLB's root transform, so the preview shares the mesh's object space", async () => {
    const normalized = expectOk(normalizeGlb(buildGridGlb({ n: 80 }), { sourceUnits: "cm", sourceUpAxis: "+Z" }));
    const out = expectOk(await simplifyGlb(normalized.bytes, { targetTriangles: 1_500, targetError: 0.05 }));
    if (out.status !== "simplified") throw new Error(out.reason);
    expect(glbJson(out.bytes).nodes).toEqual(glbJson(normalized.bytes).nodes);
    const after = inspect(out.bytes).bounds!;
    for (const axis of [0, 1, 2]) {
      expect(after.min[axis]).toBeCloseTo(normalized.localBounds.min[axis], 3);
      expect(after.max[axis]).toBeCloseTo(normalized.localBounds.max[axis], 3);
    }
  });

  it("skips a mesh that is already within budget or would barely shrink", async () => {
    const small = buildGridGlb({ n: 10 }); // 200 triangles
    expect(expectOk(await simplifyGlb(small, { targetTriangles: 200 }))).toMatchObject({ status: "skipped", sourceTriangles: 200 });
    const barely = expectOk(await simplifyGlb(small, { targetTriangles: 190 }));
    expect(barely.status).toBe("skipped");
  });

  it("refuses layouts it does not rewrite, and malformed input", async () => {
    const cases: [string, Uint8Array][] = [
      ["animations", buildGridGlb({ n: 20, extraJson: { animations: [{ channels: [], samplers: [] }] } })],
      ["non-indexed", buildGridGlb({ n: 20, nonIndexed: true })],
      ["skinned attribute", buildGridGlb({ n: 20, extraAttribute: "JOINTS_0" })],
      ["required extension", buildGridGlb({ n: 20, extraJson: { extensionsRequired: ["KHR_texture_transform"], extensionsUsed: ["KHR_texture_transform"] } })],
    ];
    for (const [label, glb] of cases) {
      const r = await simplifyGlb(glb, { targetTriangles: 100 });
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.error.code, label).toBe("UNSUPPORTED_MEDIA");
    }
    const junk = await simplifyGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]), { targetTriangles: 100 });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error.code).toBe("INVALID_GEOMETRY");
  });

  it("is deterministic, so a recomputed preview has the same bytes", async () => {
    const source = buildGridGlb({ n: 50 });
    const [a, b] = [await simplifyGlb(source, { targetTriangles: 800 }), await simplifyGlb(source, { targetTriangles: 800 })];
    const [x, y] = [expectOk(a), expectOk(b)];
    if (x.status !== "simplified" || y.status !== "simplified") throw new Error("expected a simplification");
    expect(Buffer.from(x.bytes).equals(Buffer.from(y.bytes))).toBe(true);
  });
});
