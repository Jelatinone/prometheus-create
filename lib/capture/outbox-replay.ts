/**
 * Replay a capture-agent outbox (services/capture-agent/capture_agent/outbox.py)
 * through the AssetCatalog + IngestionGateway ports. Node-only (reads files);
 * not exported from the browser-safe lib/capture index.
 *
 * This is the hand-off seam until the platform's ingest endpoint exists: the
 * agent writes exactly what it would POST, and this proves the gateway
 * accepts it (frame asset IDs, hashes, sizes, sequence semantics).
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  IngestEnvelope,
  SourceRegistration,
  err,
  ok,
  parseContract,
  type Actor,
  type AssetCatalog,
  type IngestResult,
  type IngestionGateway,
  type Result,
  type Source,
} from "@/lib/contracts";
import { storeProjectAsset } from "./assets";
import type { BlobStore } from "./blob-store";

export interface OutboxFrame {
  file: string;
  envelope: unknown;
  bytes: Uint8Array;
}

export interface OutboxFiles {
  registration: unknown;
  frames: OutboxFrame[];
}

export function readOutbox(dir: string): OutboxFiles {
  const registration = JSON.parse(readFileSync(resolve(dir, "source-registration.json"), "utf8"));
  const frameFiles = readdirSync(resolve(dir, "frames"));
  const frames = readdirSync(resolve(dir, "envelopes"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const stem = file.replace(/\.json$/, "");
      const frameFile = frameFiles.find((f) => f.startsWith(`${stem}.`));
      if (!frameFile) throw new Error(`outbox ${dir}: no frame bytes for envelope ${file}`);
      return {
        file,
        envelope: JSON.parse(readFileSync(resolve(dir, "envelopes", file), "utf8")),
        bytes: new Uint8Array(readFileSync(resolve(dir, "frames", frameFile))),
      };
    });
  return { registration, frames };
}

export interface ReplayDeps {
  assets: AssetCatalog;
  ingestion: IngestionGateway;
  blobs: BlobStore;
  actor: Actor;
}

export interface ReplayEntry {
  file: string;
  result: Result<IngestResult>;
}

/**
 * Register the outbox's source, store each frame, and ingest each envelope in
 * the given order. Per-frame failures are reported, not thrown, so duplicate
 * and out-of-order behavior is visible.
 */
export async function replayOutbox(deps: ReplayDeps, files: OutboxFiles): Promise<Result<{ source: Source; entries: ReplayEntry[] }>> {
  const reg = parseContract(SourceRegistration, files.registration);
  if (!reg.ok) return reg;
  const source = await deps.ingestion.registerSource(deps.actor, reg.value);
  if (!source.ok) return source;
  const entries: ReplayEntry[] = [];
  for (const frame of files.frames) {
    const envelope = parseContract(IngestEnvelope, frame.envelope);
    if (!envelope.ok) {
      entries.push({ file: frame.file, result: envelope });
      continue;
    }
    const e = envelope.value;
    const asset = await storeProjectAsset(deps, e.projectId, frame.bytes, { kind: "frame", mimeType: e.frame.mimeType, origin: "capture" });
    if (!asset.ok) {
      entries.push({ file: frame.file, result: asset });
      continue;
    }
    if (asset.value.id !== e.frame.assetId || asset.value.byteSize !== e.frame.byteSize || asset.value.contentHash !== e.frame.contentHash) {
      entries.push({
        file: frame.file,
        result: err("INVALID_SCHEMA", `frame bytes do not match the envelope (asset ${asset.value.id} vs ${e.frame.assetId})`),
      });
      continue;
    }
    entries.push({ file: frame.file, result: await deps.ingestion.ingest(deps.actor, e) });
  }
  return ok({ source: source.value, entries });
}
