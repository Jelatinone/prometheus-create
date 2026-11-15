/**
 * Scene splat from one capture (CP-030 experiment; paid, not part of the app yet).
 *
 *   npx tsx scripts/scene-splat.mts <sourceId> [--max-points 300000]
 *
 * Sends every frame of the capture to fal-ai/vggt-1b, which estimates all camera
 * poses together and returns one fused coloured point cloud, then writes it as an
 * S1 splat (.ply) under .verify/cp030/ for "Add splat" in the editor. Black
 * letterbox bars and outlier points are dropped; the scale is VGGT's, not meters.
 * A cold VGGT GPU can queue for several minutes before the ~10 s run.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const { createPool } = await import("../lib/server/db");
const { createSignedDownload, objectPath } = await import("../lib/server/storage");
const { createLiveFalQueue } = await import("../lib/reconstruction/fal-live");
const { pointsFromGlb, pointsToS1Splat } = await import("../lib/reconstruction/scene-splat");
const { checkSplatPly } = await import("../lib/scene/splat");

const sourceId = process.argv[2];
if (!sourceId?.startsWith("src_")) throw new Error("usage: scene-splat.mts <sourceId> [--max-points N]");
const maxPointsArg = process.argv.indexOf("--max-points");
const maxPoints = maxPointsArg > 0 ? Number(process.argv[maxPointsArg + 1]) : 300_000;

const pool = createPool(process.env.DATABASE_URL!);
const fal = createLiveFalQueue();
const frames = (await pool.query("select project_id, frame_asset_id from observations where source_id = $1 order by source_time_us", [sourceId])).rows;
if (frames.length < 2) throw new Error(`${sourceId} has ${frames.length} frame(s); a scene splat needs several`);
const urls: string[] = [];
for (const f of frames) {
  const signed = await createSignedDownload(objectPath(f.project_id, f.frame_asset_id), 900);
  if (!signed.ok) throw new Error(signed.error.message);
  urls.push(signed.value);
}
console.log(`${frames.length} frames -> fal-ai/vggt-1b`);
const endpoint = "fal-ai/vggt-1b";
const { requestId } = await fal.submit(endpoint, { image_urls: urls, export_point_cloud: true, max_points: maxPoints, confidence_percentile: 35 });
console.log(`request ${requestId}`);
const started = Date.now();
let last = "";
for (;;) {
  const s = await fal.status(endpoint, requestId);
  if (s.status !== last) console.log(`${(last = s.status)} after ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (s.status === "COMPLETED") break;
  if (Date.now() - started > 600_000) throw new Error(`still running after 10 min; fetch ${requestId} later`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
const result = (await fal.result(endpoint, requestId)) as { data?: { point_cloud?: { url: string } }; point_cloud?: { url: string } };
const cloudUrl = (result.data ?? result).point_cloud?.url;
if (!cloudUrl) throw new Error("VGGT returned no point cloud");
const glb = (await fal.download(cloudUrl)).bytes;
const ply = pointsToS1Splat(pointsFromGlb(glb), { voxelFraction: 1 / 500 });
const check = checkSplatPly(ply);
mkdirSync(".verify/cp030", { recursive: true });
const out = `.verify/cp030/scene-${sourceId.slice(4, 12)}.ply`;
writeFileSync(out, ply);
console.log(`${out}: ${check.ok ? check.info.vertexCount.toLocaleString() : check.reason} splats, ${(ply.length / 1e6).toFixed(1)} MB`);
await pool.end();
