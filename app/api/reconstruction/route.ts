import { getActor } from "@/lib/server/auth";
import { getBackend } from "@/lib/server/backend";
import { respond } from "@/lib/server/http";
import { err } from "@/lib/contracts";
import { createLiveFalQueue } from "@/lib/reconstruction/fal-live";
import { reconstructionCommand } from "@/lib/reconstruction/http";
import { serverBlobs } from "@/lib/reconstruction/server-blobs";
import { createPool, type Pool } from "@/lib/server/db";
import { databaseUrl } from "@/lib/server/env";

export const maxDuration = 60;
const holder = globalThis as typeof globalThis & { __reconstructionLocks?: Pool };

export async function POST(request: Request) {
  try {
    const actor = await getActor(request);
    if (!actor) return respond(err("UNAUTHORIZED", "sign in required"));
    const backend = getBackend();
    return await reconstructionCommand(request, { backend, actor, blobs: serverBlobs(backend, actor), fal: createLiveFalQueue }, async (key, action) => {
      // Across requests/processes, one job ID can only be submitted or finalized once.
      // A separate lock pool leaves the backend pool free for the work itself.
      // Otherwise simultaneous lock holders could exhaust all data connections.
      holder.__reconstructionLocks ??= createPool(databaseUrl(), { max: 3 });
      const client = await holder.__reconstructionLocks.connect();
      let acquired = false;
      try {
        const result = await client.query<{ acquired: boolean }>("select pg_try_advisory_lock(hashtext($1)) as acquired", [key]);
        acquired = result.rows[0].acquired;
        if (!acquired) return respond(err("PROVIDER_UNAVAILABLE", "this job is processing in another request; resume shortly"));
        return await action();
      } finally {
        try { if (acquired) await client.query("select pg_advisory_unlock(hashtext($1))", [key]); }
        finally { client.release(); }
      }
    });
  } catch {
    return respond(err("PROVIDER_UNAVAILABLE", "reconstruction is temporarily unavailable; resume the saved job instead of submitting again"));
  }
}
