/**
 * Project download and import as a .zip (HK-004 save viewer).
 *
 *   project.json          format marker, title, and every take's head manifest
 *   assets/<assetId>.<ext> the bytes of every asset those manifests reference
 *
 * Import creates a NEW project (fresh project, take and asset IDs), so an
 * archive can be imported any number of times without colliding. Forks come
 * back as forks of the original take; capture sources and observations are not
 * part of the archive (provenance IDs are kept as text only).
 *
 * The zip writer stores entries uncompressed (GLB and images barely compress);
 * the reader also accepts deflated entries, so a re-zipped archive imports.
 */
import { loadProjectAsset, storeProjectAsset } from "@/lib/capture/assets";
import type { BlobStore } from "@/lib/capture/blob-store";
import type { Asset } from "@/lib/contracts/asset";
import { err, newId, ok, type Result } from "@/lib/contracts/common";
import type { Actor, AssetCatalog, ProjectRepository } from "@/lib/contracts/ports";
import { collectAssetIds, TakeManifest } from "@/lib/contracts/revision";

export const ARCHIVE_FORMAT = "prometheus-create.project";
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export interface ArchiveDeps {
  projects: ProjectRepository;
  assets: AssetCatalog;
  blobs: BlobStore;
  actor: Actor;
}

interface ArchiveTake {
  takeId: string;
  name: string;
  parentTakeId: string | null;
  headRevision: number;
  manifest: TakeManifest;
}

interface ArchiveAsset {
  id: string;
  kind: Asset["kind"];
  mimeType: string;
  origin: Asset["origin"];
  contentHash: string;
  byteSize: number;
  path: string;
}

export interface ProjectArchive {
  format: typeof ARCHIVE_FORMAT;
  version: 1;
  exportedAt: string;
  sourceProjectId: string;
  title: string;
  activeTakeId: string;
  takes: ArchiveTake[];
  assets: ArchiveAsset[];
}

const EXT: Record<string, string> = {
  "model/gltf-binary": "glb",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const key = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportProject(deps: ArchiveDeps, projectId: string): Promise<Result<{ title: string; zip: Uint8Array }>> {
  const project = await deps.projects.getProject(deps.actor, projectId);
  if (!project.ok) return project;
  const summaries = await deps.projects.listTakes(deps.actor, projectId);
  if (!summaries.ok) return summaries;

  const takes: ArchiveTake[] = [];
  for (const t of summaries.value) {
    const head = await deps.projects.getRevision(deps.actor, projectId, t.takeId);
    if (!head.ok) return head;
    takes.push({ takeId: t.takeId, name: t.name, parentTakeId: t.parent?.takeId ?? null, headRevision: head.value.number, manifest: head.value.manifest });
  }

  const files: ZipFile[] = [];
  const assets: ArchiveAsset[] = [];
  const ids = [...new Set(takes.flatMap((t) => collectAssetIds(t.manifest)))].sort();
  for (const id of ids) {
    const loaded = await loadProjectAsset({ assets: deps.assets, blobs: deps.blobs, actor: deps.actor }, projectId, id);
    if (!loaded.ok) return loaded;
    const a = loaded.value.asset;
    const path = `assets/${a.id}.${EXT[a.mimeType] ?? "bin"}`;
    assets.push({ id: a.id, kind: a.kind, mimeType: a.mimeType, origin: a.origin, contentHash: a.contentHash, byteSize: a.byteSize, path });
    files.push({ name: path, bytes: loaded.value.bytes });
  }

  const archive: ProjectArchive = {
    format: ARCHIVE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceProjectId: projectId,
    title: project.value.title,
    activeTakeId: project.value.activeTakeId,
    takes,
    assets,
  };
  files.unshift({ name: "project.json", bytes: new TextEncoder().encode(JSON.stringify(archive, null, 2)) });
  return ok({ title: project.value.title, zip: buildZip(files) });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function retarget<T>(value: T, ids: Map<string, string>): T {
  let text = JSON.stringify(value);
  for (const [from, to] of ids) text = text.replaceAll(`"${from}"`, `"${to}"`);
  return JSON.parse(text) as T;
}

function readArchive(json: unknown): Result<ProjectArchive> {
  const a = json as Partial<ProjectArchive> | null;
  if (!a || a.format !== ARCHIVE_FORMAT || a.version !== 1 || !Array.isArray(a.takes) || !Array.isArray(a.assets) || typeof a.title !== "string")
    return err("INVALID_SCHEMA", "project.json is not a Prometheus::create project archive (version 1)");
  if (!a.takes.length) return err("INVALID_SCHEMA", "the archive has no takes");
  for (const t of a.takes) {
    const parsed = TakeManifest.safeParse(t.manifest);
    if (!parsed.success) return err("INVALID_SCHEMA", `take "${t.name}" has an invalid manifest: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return ok(a as ProjectArchive);
}

/** Imports an archive as a new project; resolves to the new project ID. */
export async function importProject(deps: ArchiveDeps, zip: Uint8Array, title?: string): Promise<Result<{ projectId: string }>> {
  if (zip.byteLength > MAX_ARCHIVE_BYTES) return err("TOO_LARGE", "the archive is larger than 200 MB");
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(zip);
  } catch (e) {
    return err("INVALID_SCHEMA", `not a readable .zip: ${(e as Error).message}`);
  }
  const index = files.get("project.json");
  if (!index) return err("INVALID_SCHEMA", "the .zip has no project.json");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(index));
  } catch {
    return err("INVALID_SCHEMA", "project.json is not valid JSON");
  }
  const parsed = readArchive(json);
  if (!parsed.ok) return parsed;
  const archive = parsed.value;

  const projectId = newId("project");
  const ids = new Map<string, string>([[archive.sourceProjectId, projectId]]);
  for (const t of archive.takes) ids.set(t.takeId, newId("take"));
  const original = archive.takes.find((t) => !t.parentTakeId || !ids.has(t.parentTakeId)) ?? archive.takes[0];
  const originalManifest = retarget(original.manifest, ids);
  originalManifest.take.parent = null;

  // 1. Project with the original take, empty, so assets have a project to belong to.
  const empty = structuredClone(originalManifest);
  empty.scene.objects = [];
  empty.scene.scale = { status: "estimated", reference: null };
  empty.take.tracks = [];
  const created = await deps.projects.createProject(deps.actor, {
    projectId,
    title: (title ?? archive.title).trim().slice(0, 120) || "Imported project",
    initialManifest: empty,
    idempotencyKey: key("import"),
  });
  if (!created.ok) return created;

  // 2. Assets: re-stored under the new project (content-derived IDs change with the project).
  for (const a of archive.assets) {
    const bytes = files.get(a.path);
    if (!bytes) return err("MISSING_ASSET", `the archive is missing ${a.path}`);
    const stored = await storeProjectAsset({ assets: deps.assets, blobs: deps.blobs, actor: deps.actor }, projectId, bytes, {
      kind: a.kind,
      mimeType: a.mimeType,
      origin: a.origin,
    });
    if (!stored.ok) return stored;
    ids.set(a.id, stored.value.id);
  }

  // 3. The original take's content, then every other take as a fork of it.
  const full = retarget(original.manifest, ids);
  full.take.parent = null;
  const saved = await deps.projects.saveRevision(deps.actor, {
    projectId,
    takeId: full.take.id,
    expectedRevision: 1,
    manifest: full,
    idempotencyKey: key("import"),
    message: "Imported from archive",
  });
  if (!saved.ok) return saved;

  for (const t of archive.takes) {
    if (t === original) continue;
    const newTakeId = ids.get(t.takeId)!;
    const fork = await deps.projects.forkTake(deps.actor, {
      projectId,
      fromTakeId: full.take.id,
      fromRevision: saved.value.revision,
      newTakeId,
      name: t.name.slice(0, 80) || "Alternate",
      idempotencyKey: key("import"),
    });
    if (!fork.ok) return fork;
    const head = await deps.projects.getRevision(deps.actor, projectId, newTakeId);
    if (!head.ok) return head;
    const manifest = retarget(t.manifest, ids);
    manifest.take.parent = head.value.manifest.take.parent;
    const savedFork = await deps.projects.saveRevision(deps.actor, {
      projectId,
      takeId: newTakeId,
      expectedRevision: head.value.number,
      manifest,
      idempotencyKey: key("import"),
      message: "Imported from archive",
    });
    if (!savedFork.ok) return savedFork;
  }
  return ok({ projectId });
}

// ---------------------------------------------------------------------------
// Minimal zip (PKWARE APPNOTE): stored writer; stored + deflate reader.
// ---------------------------------------------------------------------------

export interface ZipFile {
  name: string;
  bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.bytes);
    centrals.push(central);
    offset += local.length + f.bytes.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(zip: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(dataStart, dataStart + size);
    const bytes = method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : null;
    if (!bytes) throw new Error(`${name}: unsupported compression method ${method}`);
    if (crc32(bytes) !== crc) throw new Error(`${name}: checksum mismatch`);
    // Archives zipped by hand often add a top-level folder; index by the path below it too.
    files.set(name, bytes);
    const slash = name.indexOf("/");
    if (slash > 0 && !files.has(name.slice(slash + 1))) files.set(name.slice(slash + 1), bytes);
  }
  return files;
}
