import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { CaptureIngestor, MemoryBlobStore, createCaptureProject, type FrameEncoder } from "@/lib/capture";
import type { Result } from "@/lib/contracts";

export const CAPTURE_FIXTURES = resolve(import.meta.dirname, "../../fixtures/capture");

export function captureFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(CAPTURE_FIXTURES, name)));
}

export function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export function codeOf<T>(r: Result<T>): string {
  return r.ok ? "ok" : r.error.code;
}

/** A MemoryBackend project with a capture ingestor bound to it. */
export async function captureHarness(options: { encoder?: FrameEncoder; clock?: () => Date } = {}) {
  let clock = new Date("2026-11-14T20:00:00.000Z");
  const now = options.clock ?? (() => clock);
  const backend = new MemoryBackend({ now });
  const actor = { userId: "user_capture" };
  const created = expectOk(await createCaptureProject(backend.projects, actor, "Capture test"));
  const blobs = new MemoryBlobStore();
  const ingestor = new CaptureIngestor({
    assets: backend.assets,
    ingestion: backend.ingestion,
    blobs,
    actor,
    projectId: created.project.id,
    encoder: options.encoder,
    now,
  });
  return {
    backend,
    actor,
    blobs,
    ingestor,
    projectId: created.project.id,
    setClock(d: Date) {
      clock = d;
    },
  };
}
