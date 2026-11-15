/**
 * The provider seam for fal's asynchronous queue (submit -> status -> result).
 *
 * The runner depends only on this interface; `createLiveFalQueue` (./fal-live,
 * server-only) implements it with @fal-ai/client, and tests inject fakes to
 * exercise failure paths. A fake never counts as a live proof.
 */

export const SAM3D_OBJECTS_MODEL = "fal-ai/sam-3/3d-objects";
export const SAM3_IMAGE_MODEL = "fal-ai/sam-3/image";

/**
 * Listed prices (fal model pages, read 2026-11-14) for spend estimates only;
 * fal bills from prepaid credits and does not charge server errors or queue time.
 */
export const FAL_LISTED_PRICE_USD: Record<string, number> = {
  [SAM3D_OBJECTS_MODEL]: 0.02,
  [SAM3_IMAGE_MODEL]: 0.005,
};

export const FAL_CREDITS_URL = "https://fal.ai/dashboard/usage-billing/credits";

export type FalQueueState = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export interface FalStatus {
  status: FalQueueState;
  queuePosition?: number;
  /** Human-readable provider error on a failed COMPLETED request, if reported. */
  error?: string | null;
}

export interface FalQueue {
  /** Upload bytes to provider storage; returns a URL the model can fetch. */
  upload(bytes: Uint8Array, mimeType: string, fileName: string): Promise<string>;
  /** Enqueue a request. Returns the provider request ID (store it before polling). */
  submit(endpointId: string, input: Record<string, unknown>): Promise<{ requestId: string }>;
  status(endpointId: string, requestId: string): Promise<FalStatus>;
  /** The model output object for a COMPLETED request. */
  result(endpointId: string, requestId: string): Promise<unknown>;
  /** Download a provider output file (temporary URL) into memory. */
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

/** Provider failure with an optional HTTP status (e.g. 422 validation). */
export class FalQueueError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "FalQueueError";
  }
}

/** fal File object as documented for sam-3 outputs. */
export interface FalFile {
  url: string;
  content_type?: string | null;
  file_name?: string | null;
  file_size?: number | null;
}

/** Documented fields of the fal-ai/sam-3/3d-objects output we rely on. */
export interface Sam3dObjectsOutput {
  model_glb?: FalFile | null;
  gaussian_splat?: FalFile | null;
  individual_glbs?: (FalFile | null)[] | null;
  /** objects_bundle.zip: metadata.json, combined_scene.glb and object_NN/{mesh.glb,splat.ply} (object-local). */
  artifacts_zip?: FalFile | null;
  metadata?: { object_index: number; scale?: unknown; rotation?: unknown; translation?: unknown; camera_pose?: unknown }[];
}

export interface Sam3ImageOutput {
  masks?: (FalFile & { width?: number; height?: number })[];
  scores?: number[];
}

function isFile(value: unknown): value is FalFile {
  return typeof value === "object" && value !== null && typeof (value as FalFile).url === "string" && (value as FalFile).url.length > 0;
}

/** The single-object GLB from a 3d-objects output, or null when absent. */
export function pickGlb(output: unknown): FalFile | null {
  const o = (output ?? {}) as Sam3dObjectsOutput;
  if (isFile(o.model_glb)) return o.model_glb;
  const first = o.individual_glbs?.find(isFile);
  return first ?? null;
}

/** The per-object artifacts bundle, or null when absent. */
export function pickBundle(output: unknown): FalFile | null {
  const o = (output ?? {}) as Sam3dObjectsOutput;
  return isFile(o.artifacts_zip) ? o.artifacts_zip : null;
}

export function pickMasks(output: unknown): FalFile[] {
  const o = (output ?? {}) as Sam3ImageOutput;
  return (o.masks ?? []).filter(isFile);
}
