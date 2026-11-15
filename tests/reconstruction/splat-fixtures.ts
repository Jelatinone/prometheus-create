/** Synthetic Gaussian-splat PLYs for tests (not provider output). */
import { S1_PROPERTIES } from "@/lib/reconstruction";

export interface TestGaussian {
  p: [number, number, number];
  /** Log-scales. */
  scale?: [number, number, number];
  /** 3DGS order (w, x, y, z). */
  rot?: [number, number, number, number];
  /** Logit opacity. */
  opacity?: number;
  color?: [number, number, number];
}

/** Provider-style PLY; with normals it matches fal's 17-float layout. */
export function buildSplatPly(gaussians: TestGaussian[], options: { withNormals?: boolean } = {}): Uint8Array {
  const props = options.withNormals
    ? ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    : [...S1_PROPERTIES];
  const header = new TextEncoder().encode(
    ["ply", "format binary_little_endian 1.0", `element vertex ${gaussians.length}`, ...props.map((p) => `property float ${p}`), "end_header", ""].join("\n"),
  );
  const out = new Uint8Array(header.byteLength + gaussians.length * props.length * 4);
  out.set(header);
  const view = new DataView(out.buffer, header.byteLength);
  gaussians.forEach((g, i) => {
    const v: Record<string, number> = {
      x: g.p[0], y: g.p[1], z: g.p[2], nx: 0, ny: 0, nz: 0,
      f_dc_0: g.color?.[0] ?? 0.1, f_dc_1: g.color?.[1] ?? 0.2, f_dc_2: g.color?.[2] ?? 0.3,
      opacity: g.opacity ?? 2,
      scale_0: g.scale?.[0] ?? -4, scale_1: g.scale?.[1] ?? -4, scale_2: g.scale?.[2] ?? -4,
      rot_0: g.rot?.[0] ?? 1, rot_1: g.rot?.[1] ?? 0, rot_2: g.rot?.[2] ?? 0, rot_3: g.rot?.[3] ?? 0,
    };
    props.forEach((p, k) => view.setFloat32((i * props.length + k) * 4, v[p], true));
  });
  return out;
}

/** Read every Gaussian of an S1 file (fixed property order). */
export function readS1(bytes: Uint8Array): Record<(typeof S1_PROPERTIES)[number], number>[] {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const start = text.indexOf("end_header\n") + "end_header\n".length;
  const count = Number(/element vertex (\d+)/.exec(text)![1]);
  const view = new DataView(bytes.buffer, bytes.byteOffset + start);
  return Array.from({ length: count }, (_, i) =>
    Object.fromEntries(S1_PROPERTIES.map((p, k) => [p, view.getFloat32((i * S1_PROPERTIES.length + k) * 4, true)])) as Record<(typeof S1_PROPERTIES)[number], number>,
  );
}
