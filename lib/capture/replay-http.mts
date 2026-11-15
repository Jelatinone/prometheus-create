/** Persist an existing outbox, optionally following new frames during a call.
 * INGEST_API_URL=http://localhost:3005 INGEST_ACCESS_TOKEN=<short-lived user token>
 * tsx lib/capture/replay-http.mts <outbox> [--watch-seconds 90]
 * Tokens stay in the environment, never arguments or logs. Only stale previews are dropped.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { HttpBackend } from "../platform/http-backend";
import { PlatformBlobStore } from "../platform/blob-store";
import { emptyCaptureManifest } from "./project";
import { storeProjectAsset } from "./assets";
import { IngestEnvelope, INGEST_LIMITS } from "../contracts/ingestion";
import { SourceRegistration } from "../contracts/source";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: tsx lib/capture/replay-http.mts <outbox> [--watch-seconds 90]");
const baseUrl = process.env.INGEST_API_URL;
const token = process.env.INGEST_ACCESS_TOKEN;
if (!baseUrl || !token) throw new Error("INGEST_API_URL and INGEST_ACCESS_TOKEN are required");
const url = new URL(baseUrl);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  throw new Error("ingestion requires HTTPS or localhost");
const actor = { userId: "verified-by-server" };
const api = new HttpBackend({ baseUrl, authorize: () => ({ headers: { authorization: `Bearer ${token}` } }) });
const blobs = new PlatformBlobStore({ api, actor });
const registration = SourceRegistration.parse(JSON.parse(readFileSync(resolve(dir, "source-registration.json"), "utf8")));
const project = await api.projects.getProject(actor, registration.projectId);
if (!project.ok) {
  if (project.error.code !== "NOT_FOUND") throw new Error(`${project.error.code}: ${project.error.message}`);
  const created = await api.projects.createProject(actor, {
    projectId: registration.projectId, title: "Chert room scan", initialManifest: emptyCaptureManifest(registration.projectId),
    idempotencyKey: `capture-${registration.projectId}`,
  });
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
}
const source = await api.ingestion.registerSource(actor, registration);
if (!source.ok) throw new Error(`${source.error.code}: ${source.error.message}`);
const index = process.argv.indexOf("--watch-seconds");
const deadline = Date.now() + (index < 0 ? 0 : Number(process.argv[index + 1]) * 1000);
const entries: { file: string; status: string; observationId?: string }[] = [];
const seen = new Set<string>();
do {
  for (const file of readdirSync(resolve(dir, "envelopes")).filter(f => f.endsWith(".json")).sort()) {
    if (seen.has(file)) continue;
    const envelope = IngestEnvelope.parse(JSON.parse(readFileSync(resolve(dir, "envelopes", file), "utf8")));
    // Delayed previews are deliberately disposable; evidence retains its original timestamps.
    if (envelope.mode === "preview" && envelope.capturedAt && Date.now() - Date.parse(envelope.capturedAt) > INGEST_LIMITS.maxPreviewLagMs) {
      entries.push({ file, status: "dropped_stale_preview" }); seen.add(file); continue;
    }
    const frame = resolve(dir, "frames", file.replace(/\.json$/, ".jpg"));
    if (!existsSync(frame)) continue;
    const asset = await storeProjectAsset({ assets: api.assets, blobs, actor }, registration.projectId, new Uint8Array(readFileSync(frame)), {
      kind: "frame", mimeType: envelope.frame.mimeType, origin: "capture",
    });
    if (!asset.ok) throw new Error(`${asset.error.code}: ${asset.error.message}`);
    if (asset.value.id !== envelope.frame.assetId) throw new Error("frame asset ID mismatch");
    const result = await api.ingestion.ingest(actor, envelope);
    if (!result.ok && result.error.code !== "STALE_FRAME") throw new Error(`${result.error.code}: ${result.error.message}`);
    entries.push({ file, status: result.ok ? result.value.status : "dropped_stale_preview", ...(result.ok ? { observationId: result.value.observationId } : {}) });
    seen.add(file);
    console.log(`${file}: ${entries.at(-1)!.status}`);
  }
  const sessionFile = resolve(dir, "capture-session.json");
  if (existsSync(sessionFile)) {
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (session.state === "ended" || session.state === "failed") break;
  }
  if (Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
} while (Date.now() < deadline);
const observations = await api.ingestion.listObservations(actor, registration.projectId, registration.id);
if (!observations.ok) throw new Error(`${observations.error.code}: ${observations.error.message}`);
writeFileSync(resolve(dir, "http-ingest-result.json"), JSON.stringify({ sourceId: registration.id, projectId: registration.projectId, entries, observations: observations.value }, null, 2));
console.log(`Persistent read-back: ${observations.value.length} observations in ${registration.projectId}`);
