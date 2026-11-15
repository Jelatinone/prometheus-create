/**
 * Live reconstruction proof (HK-002): a real photo -> CT-002 capture records ->
 * fal mask (optional) -> fal-ai/sam-3/3d-objects job -> validated, normalized GLB.
 *
 *   npx tsx lib/reconstruction/live-run.ts --image chair.jpg --prompt chair
 *   npx tsx lib/reconstruction/live-run.ts --image chair.jpg --mask chair-mask.png
 *
 * Options:
 *   --image <path>    owned photo (PNG/JPEG/WebP)                  [required]
 *   --upright <path>  upright copy of an EXIF-rotated photo (e.g. Pillow exif_transpose)
 *   --mask <path>     mask on the upright frame's pixel grid (white = object)
 *   --prompt <text>   no --mask: obtain one from fal-ai/sam-3/image with this prompt
 *   --units <m|cm|mm|unknown>  --up <+Y|+Z|unknown>  GLB convention (default unknown)
 *   --timeout <s>     provider timeout per job (default 600)
 *   --out <dir>       output folder (default .verify/hk002-live/<timestamp>, git-ignored)
 *   --note <text>     consent/provenance note for the source (default does not assert ownership;
 *                     say "Owner photo …" only for a photo the user owns)
 *
 * Reads FAL_KEY (or FAL_API_KEY) from the environment or .env.local; never
 * prints it. Runs in memory (MemoryBackend) until the platform backend exists.
 * Paid: listed at $0.005 per sam-3/image mask and $0.02 per 3d-objects job; the
 * run prints its estimated spend.
 * Written as CommonJS-compatible TypeScript so tsx can load the contracts index.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { CaptureIngestor, MemoryBlobStore, createCaptureProject, loadProjectAsset, probeImage, storeProjectAsset } from "@/lib/capture";
import type { Result } from "@/lib/contracts";
import { FAL_CREDITS_URL, FAL_LISTED_PRICE_USD } from "./fal-queue";
import { createLiveFalQueue, falKeyFromEnv } from "./fal-live";
import { runReconstruction, runSegmentation, type GlbConvention, type JobProgress } from "./runner";

/** jobId -> model for every job that reached the provider (billable). */
const submitted = new Map<string, string>();

function estimatedSpend(): number {
  return [...submitted.values()].reduce((sum, model) => sum + (FAL_LISTED_PRICE_USD[model] ?? 0), 0);
}

function printSpend() {
  console.log(`estimated spend this run: $${estimatedSpend().toFixed(3)} at listed prices (${submitted.size} submitted job(s)); balance: ${FAL_CREDITS_URL}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function must<T>(r: Result<T>, step: string): T {
  if (!r.ok) {
    console.error(`FAIL ${step}: ${r.error.code} ${r.error.message}`);
    if (r.error.details) console.error(JSON.stringify(r.error.details, null, 2));
    process.exit(1);
  }
  return r.value;
}

function log(event: JobProgress) {
  const t = new Date().toISOString();
  if (event.type === "state") {
    const j = event.job;
    if (j.providerRequestId) submitted.set(j.id, j.providerModel);
    console.log(`${t}  job ${j.id} (${j.kind}) -> ${j.state}${j.providerRequestId ? `  request ${j.providerRequestId}` : ""}${j.error ? `  ${j.error.code}: ${j.error.message}` : ""}`);
  } else {
    console.log(`${t}  poll ${event.status}${event.queuePosition !== undefined ? ` (queue ${event.queuePosition})` : ""}  ${(event.elapsedMs / 1000).toFixed(1)}s`);
  }
}

async function main() {
  const envFile = resolve(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const imagePath = arg("image");
  if (!imagePath) {
    console.error("usage: npx tsx lib/reconstruction/live-run.ts --image <photo> [--mask <png> | --prompt <text>] [--upright <png>]");
    process.exit(2);
  }
  if (!falKeyFromEnv()) {
    console.error("FAL_KEY (or FAL_API_KEY) is not set. Add it to .env.local (git-ignored) and rerun.");
    process.exit(2);
  }
  const convention: GlbConvention = {
    sourceUnits: (arg("units") as GlbConvention["sourceUnits"]) ?? "unknown",
    sourceUpAxis: (arg("up") as GlbConvention["sourceUpAxis"]) ?? "unknown",
  };
  const timeoutMs = Number(arg("timeout") ?? 600) * 1000;
  const out = resolve(arg("out") ?? `.verify/hk002-live/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  const save = (name: string, data: unknown) =>
    writeFileSync(resolve(out, name), data instanceof Uint8Array ? data : JSON.stringify(data, null, 2) + "\n");

  const backend = new MemoryBackend();
  const blobs = new MemoryBlobStore();
  const actor = { userId: "hk002-live-run" };
  const project = must(await createCaptureProject(backend.projects, actor, "HK-002 live reconstruction proof"), "create project");
  const projectId = project.project.id;

  // 1. Capture: the photo enters CT-002 exactly like an upload.
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  const uprightPath = arg("upright");
  const encoder = uprightPath
    ? {
        async reorient() {
          const bytes = new Uint8Array(readFileSync(uprightPath));
          const p = must(probeImage(bytes), "probe --upright");
          return { ok: true as const, value: { bytes, mimeType: p.mimeType, width: p.width, height: p.height } };
        },
      }
    : undefined;
  const ingestor = new CaptureIngestor({ assets: backend.assets, ingestion: backend.ingestion, blobs, actor, projectId, encoder });
  const captured = must(
    await ingestor.ingestImage({
      bytes: imageBytes,
      adapter: "upload",
      consentNote: (arg("note") ?? "HK-002 live reconstruction proof input; ownership not asserted").slice(0, 500),
    }),
    "capture",
  );
  save("source-registration.json", captured.registration);
  save("ingest-envelope.json", captured.envelope);
  save("ingest-result.json", captured.result);
  const observation = must(await backend.ingestion.latestObservation(actor, projectId, captured.source.id), "load observation");
  console.log(`source ${captured.source.id}  observation ${observation.id}  frame ${observation.frame.width}x${observation.frame.height}`);

  const fal = createLiveFalQueue();
  const deps = { jobs: backend.jobs, assets: backend.assets, blobs, fal, actor, convention, poll: { timeoutMs }, onProgress: log };
  const started = Date.now();

  // 2. Mask: supplied by the user, or obtained from fal-ai/sam-3/image with a text prompt.
  let maskAssetId: string;
  const maskPath = arg("mask");
  if (maskPath) {
    const mask = must(
      await storeProjectAsset({ assets: backend.assets, blobs, actor }, projectId, new Uint8Array(readFileSync(maskPath)), {
        kind: "mask",
        mimeType: "image/png",
        origin: "editor",
      }),
      "store mask",
    );
    maskAssetId = mask.id;
  } else {
    const prompt = arg("prompt");
    if (!prompt) {
      console.error("give --mask <png> or --prompt <text>");
      process.exit(2);
    }
    const seg = must(await runSegmentation(deps, { projectId, observation, prompt }), "segmentation");
    save("segment-job.json", seg.job);
    save("segment-output.json", seg.providerOutput);
    if (seg.job.state !== "succeeded") {
      console.error(`segmentation ${seg.job.state}: ${seg.job.error?.code} ${seg.job.error?.message}`);
      printSpend();
      process.exit(1);
    }
    maskAssetId = seg.maskAssets[0].id;
  }
  const maskBytes = must(await loadProjectAsset({ assets: backend.assets, blobs, actor }, projectId, maskAssetId), "load mask");
  save("mask.png", maskBytes.bytes);

  // 3. Reconstruction job.
  const rec = must(
    await runReconstruction(deps, { projectId, observation, maskAssetIds: [maskAssetId], targetObjectId: null, baseGeometryRevision: 0 }),
    "reconstruction",
  );
  save("reconstruction-job.json", rec.job);
  save("provider-output.json", rec.providerOutput);
  const summary = {
    note: "Live fal run. Provider URLs in provider-output.json are temporary. FAL_KEY is not recorded.",
    projectId,
    sourceId: captured.source.id,
    observationId: observation.id,
    frame: observation.frame,
    orientation: captured.orientation,
    maskAssetId,
    jobId: rec.job.id,
    state: rec.job.state,
    providerRequestId: rec.job.providerRequestId,
    error: rec.job.error,
    convention,
    apply: rec.apply,
    geometry: rec.geometry,
    recenterOffset: rec.recenterOffset,
    originalInspection: rec.originalInspection,
    normalizedInspection: rec.inspection,
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    estimatedSpendUsd: estimatedSpend(),
  };
  save("summary.json", summary);
  if (rec.rawAsset) save("raw.glb", must(await loadProjectAsset({ assets: backend.assets, blobs, actor }, projectId, rec.rawAsset.id), "load raw").bytes);
  if (rec.meshAsset) save("normalized.glb", must(await loadProjectAsset({ assets: backend.assets, blobs, actor }, projectId, rec.meshAsset.id), "load mesh").bytes);

  console.log(`\njob ${rec.job.id}: ${rec.job.state}  request ${rec.job.providerRequestId ?? "none"}`);
  if (rec.originalInspection) console.log(`raw GLB dims (file units): ${rec.originalInspection.dimensions?.map((d) => d.toFixed(3)).join(" x ")}`);
  if (rec.inspection) console.log(`normalized dims: ${rec.inspection.dimensions?.map((d) => d.toFixed(3)).join(" x ")}  warnings: ${rec.inspection.warnings.join("; ") || "none"}`);
  printSpend();
  console.log(`outputs: ${out}`);
  process.exit(rec.job.state === "succeeded" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
