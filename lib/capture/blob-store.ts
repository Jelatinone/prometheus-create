/**
 * Where asset bytes go before their metadata is recorded with AssetCatalog.
 *
 * The contracts deliberately keep bytes out of the ports (CT-002: the API
 * receives metadata, never a base64 clip). Until the platform lane provides
 * signed direct-to-storage uploads (Supabase Storage), capture code writes to
 * this lane-local seam; MemoryBlobStore backs tests and the dev harness.
 */
import { err, ok, type Result } from "@/lib/contracts";

export interface StoredBlob {
  bytes: Uint8Array;
  mimeType: string;
}

export interface BlobStore {
  /** Write bytes under an opaque private storage key. Idempotent per key + bytes. */
  put(storageKey: string, bytes: Uint8Array, mimeType: string): Promise<Result<{ storageKey: string }>>;
  get(storageKey: string): Promise<Result<StoredBlob>>;
}

/** Private storage key for a project asset. Never a public URL. */
export function assetStorageKey(projectId: string, assetId: string): string {
  return `projects/${projectId}/assets/${assetId}`;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, StoredBlob>();

  async put(storageKey: string, bytes: Uint8Array, mimeType: string): Promise<Result<{ storageKey: string }>> {
    this.blobs.set(storageKey, { bytes: bytes.slice(), mimeType });
    return ok({ storageKey });
  }

  async get(storageKey: string): Promise<Result<StoredBlob>> {
    const blob = this.blobs.get(storageKey);
    if (!blob) return err("MISSING_ASSET", `no bytes stored at ${storageKey}`);
    return ok({ bytes: blob.bytes.slice(), mimeType: blob.mimeType });
  }

  get size(): number {
    return this.blobs.size;
  }
}
