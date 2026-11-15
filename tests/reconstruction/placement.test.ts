import { describe, expect, it } from "vitest";
import { levelPlacements, objectPlacement, parseProviderMetadata, rotateVec, type QuatXYZW } from "@/lib/reconstruction";
import type { Vec3 } from "@/lib/contracts";
import { codeOf, expectOk } from "../capture/helpers";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

/** Column-vector rotation matrix of a unit quaternion given as [w, x, y, z]. */
function matrixWxyz([w, x, y, z]: number[]): number[][] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const mul = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const transpose = (m: number[][]) => m[0].map((_, c) => m.map((r) => r[c]));
const apply = (p: { position: Vec3; rotation: QuatXYZW; scale: number }, v: Vec3) => {
  const r = rotateVec(p.rotation, [v[0] * p.scale, v[1] * p.scale, v[2] * p.scale]);
  return [r[0] + p.position[0], r[1] + p.position[1], r[2] + p.position[2]];
};

// A pose like the round table's (unit quaternion, [w, x, y, z]).
const qRaw = [0.0443, -0.0544, 0.9553, 0.2871];
const qLen = Math.hypot(...qRaw);
const q = qRaw.map((v) => v / qLen);
const pose = { objectIndex: 0, scale: 0.5763, rotationWxyz: q as [number, number, number, number], translation: [0.0655, 0.0627, 1.5727] as Vec3 };
const root = { translation: [-0.01, 0.397, 0.02] as Vec3, rotation: [0, 0, 0, 1] as QuatXYZW, scale: 1 };

describe("parseProviderMetadata", () => {
  it("reads output.metadata with batched arrays and the bundle's { objects } form", () => {
    const entry = { object_index: 0, scale: [[0.5, 0.5, 0.5]], rotation: [[1, 0, 0, 0]], translation: [[0, 0, 1]], camera_pose: null };
    expect(expectOk(parseProviderMetadata([entry]))[0]).toMatchObject({ objectIndex: 0, scale: 0.5, translation: [0, 0, 1] });
    expect(expectOk(parseProviderMetadata({ objects: [entry] }))).toHaveLength(1);
  });

  it("rejects missing fields, non-uniform scale and empty metadata", () => {
    expect(codeOf(parseProviderMetadata([{ object_index: 0 }]))).toBe("INVALID_SCHEMA");
    expect(codeOf(parseProviderMetadata([{ scale: [1, 2, 1], rotation: [1, 0, 0, 0], translation: [0, 0, 1] }]))).toBe("INVALID_SCHEMA");
    expect(codeOf(parseProviderMetadata([]))).toBe("INVALID_SCHEMA");
  });
});

describe("objectPlacement", () => {
  it("equals scene = C (s R(q)^T G^-1 root^-1(p) + t), computed independently with matrices", () => {
    const placement = objectPlacement(pose, root);
    const C = [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]; // provider camera -> scene
    const Ginv = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]; // GLB (x, y, z) -> splat frame (x, -z, y)
    const Rt = transpose(matrixWxyz(q));
    for (const p of [[0, 0, 0], [0.5, 0.79, -0.5], [-0.3, 0.1, 0.4]] as Vec3[]) {
      const glb = [p[0] - root.translation[0], p[1] - root.translation[1], p[2] - root.translation[2]];
      const posed = mul(Rt, mul(Ginv, glb)).map((v, i) => pose.scale * v + pose.translation[i]);
      close(apply(placement, p), mul(C, posed));
    }
    expect(placement.scale).toBeCloseTo(pose.scale, 9);
    expect(placement.frame).toBe("provider_camera");
  });
});

describe("levelPlacements", () => {
  it("levels a frame's objects together: mean up becomes +Y, the lowest base rests on 0, layout preserved", () => {
    const a = objectPlacement(pose, root);
    const b = objectPlacement({ ...pose, translation: [0.6, 0.1, 2.1] }, root);
    const [la, lb] = levelPlacements([a, b]);
    close(la.up, [0, 1, 0], 5);
    close(lb.up, [0, 1, 0], 5);
    expect(Math.min(la.position[1], lb.position[1])).toBeCloseTo(0, 9);
    const dist = (p: { position: Vec3 }, r: { position: Vec3 }) => Math.hypot(...p.position.map((v, i) => v - r.position[i]));
    expect(dist(la, lb)).toBeCloseTo(dist(a, b), 9);
    expect(levelPlacements([])).toEqual([]);
  });
});
