/**
 * PlatformBlobStore: asset bytes in private Supabase Storage through the
 * platform API, matching capture's BlobStore shape (lib/capture/blob-store):
 *
 *   put(storageKey, bytes, mimeType) -> { storageKey }   (returned key is authoritative)
 *   get(storageKey)                  -> { bytes, mimeType }
 *
 * put: POST /api/assets/upload-url (ownership + size checked) -> PUT the
 * bytes straight to the signed Storage URL. The API never sees the bytes.
 * The caller then records metadata with assets.putAsset using the returned
 * key `<bucket>/projects/<projectId>/<assetId>`.
 *
 * Retries:
 * - asset already registered: identical bytes (same sha256) -> ok with the
 *   registered key; different bytes -> DUPLICATE.
 * - bytes uploaded but metadata never recorded (an interrupted put): Storage
 *   refuses the overwrite; put returns ok and POST /api/assets then checks
 *   the object exists with the declared size. Content is not re-hashed
 *   server-side, so this relies on content-derived asset IDs (as capture
 *   uses) for byte-exact identity.
 *
 * get: needs the asset to be registered (it signs the download from the
 * catalog record), then fetches the signed URL.
 *
 * Browser-safe: no server modules, no Supabase keys (the signed URL carries
 * its own token).
 */
import { sha256 } from "@/lib/contracts/canonical";
import { err, ok, type Result } from "@/lib/contracts/common";
import type { Actor } from "@/lib/contracts/ports";
import type { HttpBackend } from "./http-backend";

export interface StoredBlob {
  bytes: Uint8Array;
  mimeType: string;
}

export interface PlatformBlobStoreOptions {
  api: HttpBackend;
  /** The signed-in user the uploads belong to. */
  actor: Actor;
  /** Used for the Storage PUT/GET (default: global fetch). */
  fetch?: typeof fetch;
}

const KEY = /(?:^|\/)projects\/(prj_[a-z0-9][a-z0-9_-]{2,63})\/(?:assets\/)?(ast_[a-z0-9][a-z0-9_-]{2,63})$/;

/** projectId/assetId from `projects/<p>/<a>`, `projects/<p>/assets/<a>` or `<bucket>/projects/<p>/<a>`. */
export function parseAssetKey(storageKey: string): { projectId: string; assetId: string } | null {
  const match = KEY.exec(storageKey);
  return match ? { projectId: match[1], assetId: match[2] } : null;
}

export class PlatformBlobStore {
  private readonly api: HttpBackend;
  private readonly actor: Actor;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlatformBlobStoreOptions) {
    this.api = options.api;
    this.actor = options.actor;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async put(storageKey: string, bytes: Uint8Array, mimeType: string): Promise<Result<{ storageKey: string }>> {
    const ids = parseAssetKey(storageKey);
    if (!ids)
      return err("INVALID_SCHEMA", `cannot derive project and asset IDs from storage key ${storageKey}`, {
        issues: [{ path: "storageKey", message: "expected projects/<projectId>/[assets/]<assetId>" }],
      });

    const signed = await this.api.requestUpload(this.actor, { ...ids, mimeType, byteSize: bytes.byteLength });
    if (!signed.ok) {
      if (signed.error.code !== "DUPLICATE") return signed;
      // Already registered: a retry is fine only with identical bytes.
      const existing = await this.api.assets.getAsset(this.actor, ids.projectId, ids.assetId);
      if (!existing.ok) return existing;
      if (existing.value.contentHash !== (await sha256(bytes)))
        return err("DUPLICATE", `asset ${ids.assetId} is already registered with different content`);
      return ok({ storageKey: existing.value.storageKey });
    }

    const { signedUrl, storageKey: key } = signed.value.upload;
    let response: Response;
    try {
      response = await this.fetchImpl(signedUrl, {
        method: "PUT",
        headers: { "content-type": mimeType, "x-upsert": "false", "cache-control": "max-age=3600" },
        body: new Blob([bytes as BlobPart], { type: mimeType }),
      });
    } catch (error) {
      return err("PROVIDER_UNAVAILABLE", `storage upload failed: ${(error as Error).message}`);
    }
    if (response.ok) return ok({ storageKey: key });
    const detail = await response.text().catch(() => "");
    // An earlier put uploaded these bytes but never recorded metadata.
    if (/already exists|duplicate/i.test(detail)) return ok({ storageKey: key });
    return err("PROVIDER_UNAVAILABLE", `storage refused the upload (HTTP ${response.status})`, {
      status: response.status,
    });
  }

  async get(storageKey: string): Promise<Result<StoredBlob>> {
    const ids = parseAssetKey(storageKey);
    if (!ids) return err("MISSING_ASSET", `no platform asset at storage key ${storageKey}`);
    const found = await this.api.assetDownload(this.actor, ids.projectId, ids.assetId);
    if (!found.ok) return found.error.code === "NOT_FOUND" ? err("MISSING_ASSET", found.error.message) : found;
    if (found.value.asset.storageKey !== storageKey || !found.value.download)
      return err("MISSING_ASSET", `asset ${ids.assetId} is not stored at ${storageKey}`);
    let response: Response;
    try {
      response = await this.fetchImpl(found.value.download.url);
    } catch (error) {
      return err("PROVIDER_UNAVAILABLE", `storage download failed: ${(error as Error).message}`);
    }
    if (!response.ok)
      return err(response.status === 404 ? "MISSING_ASSET" : "PROVIDER_UNAVAILABLE", `storage answered HTTP ${response.status}`);
    return ok({ bytes: new Uint8Array(await response.arrayBuffer()), mimeType: found.value.asset.mimeType });
  }
}
