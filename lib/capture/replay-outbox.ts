/**
 * Replay a capture-agent outbox into a fresh MemoryBackend project and report
 * what the IngestionGateway accepted.
 *
 *   npx tsx lib/capture/replay-outbox.ts services/capture-agent/outbox/<run> [--result <file>]
 *
 * Writes the result JSON to --result (default <dir>/replay-result.json; live
 * outboxes are git-ignored). Exit code 0 only if every envelope was
 * accepted (or recognized as a duplicate).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { MemoryBlobStore } from "./blob-store";
import { readOutbox, replayOutbox } from "./outbox-replay";
import { createCaptureProject } from "./project";

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: npx tsx lib/capture/replay-outbox.ts <outbox-dir>");
    process.exit(2);
  }
  const files = readOutbox(dir);
  const projectId = (files.registration as { projectId: string }).projectId;
  const backend = new MemoryBackend();
  const actor = { userId: "hk002-outbox-replay" };
  const created = await createCaptureProject(backend.projects, actor, "HK-002 outbox replay", projectId);
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
  const replay = await replayOutbox({ assets: backend.assets, ingestion: backend.ingestion, blobs: new MemoryBlobStore(), actor }, files);
  if (!replay.ok) {
    console.error(`FAIL register source: ${replay.error.code} ${replay.error.message}`);
    process.exit(1);
  }
  let failures = 0;
  for (const { file, result } of replay.value.entries) {
    if (result.ok) console.log(`OK   ${file}: ${result.value.status} obs ${result.value.observationId} seq ${result.value.sequence} latest ${result.value.latestSequence}${result.value.outOfOrder ? " (out of order)" : ""}`);
    else {
      failures++;
      console.log(`FAIL ${file}: ${result.error.code} ${result.error.message}`);
    }
  }
  const observations = await backend.ingestion.listObservations(actor, projectId, replay.value.source.id);
  const resultIndex = process.argv.indexOf("--result");
  writeFileSync(
    resultIndex > 0 ? resolve(process.argv[resultIndex + 1]) : resolve(dir, "replay-result.json"),
    JSON.stringify({ source: replay.value.source, entries: replay.value.entries, observations: observations.ok ? observations.value : observations.error }, null, 2) + "\n",
  );
  console.log(`source ${replay.value.source.id}: ${replay.value.entries.length - failures}/${replay.value.entries.length} accepted`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
