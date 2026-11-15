import { describe, expect, it } from "vitest";
import { pointsToS1Splat, type PointCloud } from "@/lib/reconstruction/scene-splat";
import { checkSplatPly } from "@/lib/scene/splat";

function cloud(points: [number, number, number, number][]): PointCloud {
  return {
    count: points.length,
    positions: Float32Array.from(points.flatMap(([x, y, z]) => [x, y, z])),
    colors: Float32Array.from(points.flatMap(([, , , grey]) => [grey, grey, grey])),
  };
}

describe("scene splat (CP-030)", () => {
  it("writes a valid S1 splat and drops near-black letterbox points", () => {
    const lit = Array.from({ length: 200 }, (_, i) => [i % 10, Math.floor(i / 10) % 10, i % 7, 0.8] as [number, number, number, number]);
    const bars = Array.from({ length: 50 }, (_, i) => [i % 10, 0, 0, 0] as [number, number, number, number]);
    const ply = pointsToS1Splat(cloud([...lit, ...bars]), { voxelFraction: 1 / 1000 });
    const check = checkSplatPly(ply);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    // Every surviving splat comes from a lit point; no black voxel remains.
    expect(check.info.vertexCount).toBeGreaterThan(0);
    expect(check.info.vertexCount).toBeLessThanOrEqual(200);
  });
});
