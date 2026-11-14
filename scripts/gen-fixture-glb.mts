/**
 * Regenerate the shared GLB fixture (npm run fixtures:glb).
 *
 * axis-box.glb is a 0.4 x 0.9 x 0.2 m box: unequal extents make axis swaps,
 * unit errors (cm vs m) and double-applied transforms visible in tests and
 * in the /lab GLB viewer. Fixture manifests record its sha256; regenerating
 * with different bytes must update fixtures/contracts in the same change.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildBoxGlb } from "../lib/assets/glb";
import { sha256 } from "../lib/contracts/canonical";

export const AXIS_BOX_SIZE: [number, number, number] = [0.4, 0.9, 0.2];

const bytes = buildBoxGlb({
  size: AXIS_BOX_SIZE,
  name: "axis-box",
  generator: "prometheus-create fixtures:glb",
});
const out = resolve(import.meta.dirname, "../public/fixtures/axis-box.glb");
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.byteLength} bytes, ${await sha256(bytes)})`);
