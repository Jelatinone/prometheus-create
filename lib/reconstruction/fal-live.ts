/**
 * Live FalQueue on @fal-ai/client. SERVER ONLY: it reads the fal key and must
 * never be imported from a client component (the key would ship to browsers).
 *
 * The client builds queue URLs itself (status/result use the app id
 * "fal-ai/sam-3", not the endpoint subpath), which is why the adapter does
 * not hand-roll HTTP. Output files are downloaded only from fal origins.
 */
import { ApiError, createFalClient } from "@fal-ai/client";
import { FAL_CREDITS_URL, FalQueueError, type FalQueue, type FalStatus } from "./fal-queue";

/** fal's docs name the variable FAL_KEY; this project's .env.local also uses FAL_API_KEY. */
export function falKeyFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.FAL_KEY || env.FAL_API_KEY;
  if (key && /[•●]/.test(key)) throw new FalQueueError("the fal key in .env.local is a masked placeholder (bullet characters); paste the real key");
  return key || undefined;
}

function detailOf(body: unknown): string | null {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    return typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300);
  }
  return null;
}

function wrap(e: unknown): FalQueueError {
  if (e instanceof FalQueueError) return e;
  if (e instanceof ApiError) {
    const detail = detailOf(e.body);
    const exhausted = e.status === 403 && /exhausted balance/i.test(`${detail ?? ""} ${e.message}`);
    const message = exhausted
      ? `fal credits exhausted; add credits at ${FAL_CREDITS_URL} (${detail ?? e.message})`
      : detail
        ? `${e.message}: ${detail}`
        : e.message;
    return new FalQueueError(message, e.status, e.body);
  }
  return new FalQueueError(e instanceof Error ? e.message : String(e));
}

/** Provider output URLs must be https on a fal-owned host (no arbitrary fetches). */
export function isFalOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)fal\.(media|ai|run)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function createLiveFalQueue(apiKey: string | undefined = falKeyFromEnv()): FalQueue {
  if (!apiKey) throw new FalQueueError("FAL_KEY (or FAL_API_KEY) is not set; put it in .env.local and never commit it");
  const fal = createFalClient({ credentials: apiKey });

  return {
    async upload(bytes, mimeType, fileName) {
      try {
        const file = new File([bytes as BlobPart], fileName, { type: mimeType });
        return await fal.storage.upload(file);
      } catch (e) {
        throw wrap(e);
      }
    },
    async submit(endpointId, input) {
      try {
        const queued = await fal.queue.submit(endpointId, { input });
        return { requestId: queued.request_id };
      } catch (e) {
        throw wrap(e);
      }
    },
    async status(endpointId, requestId): Promise<FalStatus> {
      try {
        const s = await fal.queue.status(endpointId, { requestId, logs: false });
        const extra = s as unknown as { queue_position?: number; error?: string | null };
        return { status: s.status, queuePosition: extra.queue_position, error: extra.error ?? null };
      } catch (e) {
        throw wrap(e);
      }
    },
    async result(endpointId, requestId) {
      try {
        const r = await fal.queue.result(endpointId, { requestId });
        return r.data;
      } catch (e) {
        throw wrap(e);
      }
    },
    async download(url) {
      if (!isFalOrigin(url)) throw new FalQueueError(`refusing to download a provider output from a non-fal origin: ${new URL(url).hostname}`);
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw wrap(e);
      }
      if (!res.ok) throw new FalQueueError(`download failed: HTTP ${res.status}`, res.status);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
    },
  };
}
