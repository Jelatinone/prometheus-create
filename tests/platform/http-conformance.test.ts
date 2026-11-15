/**
 * The shared conformance suite, unchanged, through the whole HTTP stack:
 *
 *   HttpBackend (browser client) -> fetch -> app/api/**\/route.ts (real modules)
 *   -> lib/server/api handlers -> PostgresBackend -> TigerData test service
 *
 * Calls authenticate with real Supabase bearer tokens for the two test users.
 * Storage verification is replaced by a permissive gateway because the suite
 * records metadata for keys like "test/photo" that are not real objects;
 * real Storage is covered by api-live.test.ts and blob-store-live.test.ts.
 */
import { afterAll, describe, it, vi } from "vitest";
import { ok } from "@/lib/contracts/common";
import { HttpBackend } from "@/lib/platform/http-backend";
import type { StorageGateway } from "@/lib/server/api";
import { setRouteContextForTests } from "@/lib/server/route";
import * as realStorage from "@/lib/server/storage";
import { describeBackendConformance } from "../conformance/backend-conformance";
import { closePlatformHarness, platformEnv, platformHarness } from "./harness";
import { PLATFORM_ORIGIN, routeFetch } from "./route-fetch";

const env = platformEnv();

if (!env.ready) {
  describe("HttpBackend conformance", () => {
    it.skip(`skipped: ${env.reason}`, () => {});
  });
} else {
  vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });
  afterAll(async () => {
    setRouteContextForTests({});
    await closePlatformHarness();
  });

  const permissiveStorage: StorageGateway = { ...realStorage, verifyUpload: async () => ok(true) };

  describeBackendConformance("HttpBackend over app/api routes (TigerData test database)", async () => {
    const h = await platformHarness();
    setRouteContextForTests({ backend: h.backend, storage: permissiveStorage });
    const tokens = new Map([
      [h.owner.actor.userId, h.owner.accessToken],
      [h.other.actor.userId, h.other.accessToken],
    ]);
    const backend = new HttpBackend({
      baseUrl: PLATFORM_ORIGIN,
      fetch: routeFetch,
      authorize: (actor) => (actor ? { headers: { authorization: `Bearer ${tokens.get(actor.userId)}` } } : {}),
    });
    return { backend, owner: h.owner.actor, other: h.other.actor, now: () => new Date() };
  });
}
