/**
 * Private object storage (Supabase Storage) for immutable assets.
 *
 * Clients never send media through the API: they ask for a signed upload URL
 * (after an ownership check), PUT the bytes straight to Storage, then POST
 * the Asset metadata. Downloads use short-lived signed URLs, which are never
 * stored in a manifest. Ownership lives in TigerData, so Storage RLS cannot
 * check it; the server checks it and signs with the server-only secret key.
 *
 * Object layout: `<bucket>/projects/<projectId>/<assetId>`; the Asset's
 * `storageKey` is that full `bucket/path` string.
 */
import { err, ok, type Result } from "@/lib/contracts/common";
import { INGEST_LIMITS } from "@/lib/contracts/ingestion";
import type { AssetKind } from "@/lib/contracts/asset";
import { supabaseAdmin } from "./auth";
import { supabaseServerConfig } from "./env";

/** Hard cap per object; matches the bucket's fileSizeLimit (db/provision-storage.mts). */
export const MAX_OBJECT_BYTES = 50 * 1024 * 1024;
export const SIGNED_DOWNLOAD_SECONDS = 300;

const MESH_TYPES = ["model/gltf-binary"];
const MASK_TYPES = ["image/png"];

/** Accepted media types and size per asset kind (null = any type, global cap). */
export const UPLOAD_RULES: Record<AssetKind, { types: readonly string[] | null; maxBytes: number }> = {
  image: { types: INGEST_LIMITS.imageSourceMimeTypes, maxBytes: INGEST_LIMITS.maxImageSourceBytes },
  video: { types: INGEST_LIMITS.videoSourceMimeTypes, maxBytes: INGEST_LIMITS.maxVideoSourceBytes },
  frame: { types: INGEST_LIMITS.frameMimeTypes, maxBytes: INGEST_LIMITS.maxFrameBytes },
  mask: { types: MASK_TYPES, maxBytes: INGEST_LIMITS.maxFrameBytes },
  mesh: { types: MESH_TYPES, maxBytes: MAX_OBJECT_BYTES },
  collider: { types: MESH_TYPES, maxBytes: MAX_OBJECT_BYTES },
  splat: { types: null, maxBytes: MAX_OBJECT_BYTES },
  motion: { types: null, maxBytes: MAX_OBJECT_BYTES },
  export: { types: null, maxBytes: MAX_OBJECT_BYTES },
  provider_raw: { types: null, maxBytes: MAX_OBJECT_BYTES },
};

export function checkUpload(kind: AssetKind, mimeType: string, byteSize: number): Result<true> {
  const rule = UPLOAD_RULES[kind];
  if (rule.types && !rule.types.includes(mimeType))
    return err("UNSUPPORTED_MEDIA", `${kind} assets cannot be ${mimeType}`, { allowed: rule.types });
  if (byteSize > rule.maxBytes)
    return err("TOO_LARGE", `${kind} asset is ${byteSize} bytes`, { maxBytes: rule.maxBytes });
  return ok(true);
}

export function objectPath(projectId: string, assetId: string): string {
  return `projects/${projectId}/${assetId}`;
}

export function storageKeyFor(projectId: string, assetId: string, bucket = supabaseServerConfig().bucket): string {
  return `${bucket}/${objectPath(projectId, assetId)}`;
}

/** Path inside our bucket for a storage key, or null if the key points elsewhere. */
export function pathInBucket(storageKey: string, bucket = supabaseServerConfig().bucket): string | null {
  return storageKey.startsWith(`${bucket}/`) ? storageKey.slice(bucket.length + 1) : null;
}

export interface SignedUpload {
  storageKey: string;
  bucket: string;
  path: string;
  /** PUT target; also usable with supabase-js `uploadToSignedUrl(path, token, body)`. */
  signedUrl: string;
  token: string;
}

/** Signed one-shot upload to a fresh path. Never overwrites (assets are immutable). */
export async function createSignedUpload(projectId: string, assetId: string): Promise<Result<SignedUpload>> {
  const { bucket } = supabaseServerConfig();
  const path = objectPath(projectId, assetId);
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
  if (error || !data) {
    if (/exist/i.test(error?.message ?? ""))
      return err("DUPLICATE", `asset ${assetId} has already been uploaded`);
    return err("PROVIDER_UNAVAILABLE", `storage could not sign an upload: ${error?.message ?? "unknown error"}`);
  }
  return ok({ storageKey: `${bucket}/${path}`, bucket, path, signedUrl: data.signedUrl, token: data.token });
}

export interface StoredObject {
  size: number | null;
  contentType: string | null;
}

/** Metadata of an uploaded object, or null when it does not exist. */
export async function statObject(path: string): Promise<StoredObject | null> {
  const { bucket } = supabaseServerConfig();
  const { data, error } = await supabaseAdmin().storage.from(bucket).info(path);
  if (error || !data) return null;
  return { size: data.size ?? null, contentType: data.contentType ?? null };
}

export async function createSignedDownload(path: string, seconds = SIGNED_DOWNLOAD_SECONDS): Promise<Result<string>> {
  const { bucket } = supabaseServerConfig();
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(path, seconds);
  if (error || !data) return err("PROVIDER_UNAVAILABLE", `storage could not sign a download: ${error?.message ?? "unknown"}`);
  return ok(data.signedUrl);
}
