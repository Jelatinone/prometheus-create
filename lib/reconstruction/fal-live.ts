/**
 * Live FalQueue on @fal-ai/client. SERVER ONLY: it reads FAL_KEY and must
 * never be imported from a client component (the key would ship to browsers).
 *
 * The client builds queue URLs itself (status/result use the app id
 * "fal-ai/sam-3", not the endpoint subpath), which is why the adapter does
 * not hand-roll HTTP.
 */
import { ApiError, createFalClient } from "@fal-ai/client";
import { FalQueueError, type FalQueue, type FalStatus } from "./fal-queue";

function wrap(e: unknown): FalQueueError {
  if (e instanceof FalQueueError) return e;
  if (e instanceof ApiError) return new FalQueueError(e.message, e.status, e.body);
  return new FalQueueError(e instanceof Error ? e.message : String(e));
}

export function createLiveFalQueue(apiKey: string | undefined = process.env.FAL_KEY): FalQueue {
  if (!apiKey) throw new FalQueueError("FAL_KEY is not set (put it in .env.local; never commit it)");
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
