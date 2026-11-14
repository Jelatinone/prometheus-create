import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoxGlb, inspectGlb } from "@/lib/assets/glb";
import { REPO_ROOT } from "../helpers/fixtures";

const round = (v: number[] | null) => v?.map((x) => +x.toFixed(5));

describe("inspectGlb", () => {
  it("reads the shared fixture: 0.4 x 0.9 x 0.2 m, 12 triangles", () => {
    const result = inspectGlb(readFileSync(resolve(REPO_ROOT, "public/fixtures/axis-box.glb")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(round(result.value.dimensions)).toEqual([0.4, 0.9, 0.2]);
    expect(result.value.triangleCount).toBe(12);
    expect(result.value.meshCount).toBe(1);
    expect(result.value.hasNodeTransforms).toBe(false);
    expect(result.value.warnings).toEqual([]);
  });

  it("applies node TRS when computing world bounds (90° about Y swaps X and Z)", () => {
    const s = Math.SQRT1_2;
    const glb = buildBoxGlb({ size: [0.4, 0.9, 0.2], node: { translation: [1, 0, 0], rotation: [0, s, 0, s], scale: [2, 2, 2] } });
    const result = inspectGlb(glb);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasNodeTransforms).toBe(true);
    expect(round(result.value.dimensions)).toEqual([0.4, 1.8, 0.8]);
    expect(round(result.value.bounds!.min)).toEqual([0.8, -0.9, -0.4]);
  });

  it("warns when the source looks like centimeters", () => {
    const result = inspectGlb(buildBoxGlb({ size: [40, 90, 20] }));
    expect(result.ok && result.value.warnings.some((w) => w.includes("cm/mm"))).toBe(true);
  });

  it("rejects non-GLB and truncated input with INVALID_GEOMETRY", () => {
    const text = inspectGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}} padding....'));
    expect(text.ok || text.error.code).toBe("INVALID_GEOMETRY");
    const glb = buildBoxGlb({ size: [1, 1, 1] });
    const truncated = inspectGlb(glb.subarray(0, glb.byteLength - 10));
    expect(truncated.ok || truncated.error.message).toContain("truncated");
  });
});
