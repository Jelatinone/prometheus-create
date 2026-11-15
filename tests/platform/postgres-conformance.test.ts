/**
 * The platform backend must pass the shared conformance suite unchanged
 * (tests/conformance/backend-conformance.ts), here against the dedicated
 * TigerData test database with two real Supabase users.
 */
import { afterAll, describe, it, vi } from "vitest";
import { describeBackendConformance } from "../conformance/backend-conformance";
import { closePlatformHarness, platformEnv, platformHarness } from "./harness";

const env = platformEnv();

if (!env.ready) {
  describe("PostgresBackend conformance", () => {
    it.skip(`skipped: ${env.reason}`, () => {});
  });
} else {
  // Remote database round trips: allow more than vitest's 5 s default.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
  afterAll(closePlatformHarness);

  describeBackendConformance("PostgresBackend (TigerData test database)", async () => {
    const h = await platformHarness();
    return { backend: h.backend, owner: h.owner.actor, other: h.other.actor, now: () => new Date() };
  });
}
