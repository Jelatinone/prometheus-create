/**
 * Compare-and-swap under real concurrency: several saves race from the same
 * expectedRevision against the TigerData test database. Exactly one may win;
 * the rest must be REVISION_CONFLICT and the head must hold the winner.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { newId, type TakeManifest } from "@/lib/contracts";
import { retargetedFixture } from "@/lib/platform/fixture-project";
import { closePlatformHarness, platformEnv, platformHarness } from "./harness";

const env = platformEnv();
const key = () => newId("revision").replace("rev_", "key-");

if (!env.ready) {
  describe("PostgresBackend concurrency", () => {
    it.skip(`skipped: ${env.reason}`, () => {});
  });
} else {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
  afterAll(closePlatformHarness);

  describe("PostgresBackend concurrency (TigerData test database)", () => {
    it("lets exactly one of N racing saves win; the others get REVISION_CONFLICT", async () => {
      const h = await platformHarness();
      const projectId = newId("project");
      const takeId = newId("take");
      const full = retargetedFixture({ projectId, takeId, assetId: newId("asset") });
      const empty: TakeManifest = { ...full, scene: { ...full.scene, objects: [] } };
      const created = await h.backend.projects.createProject(h.owner.actor, {
        projectId,
        title: "HK-003 concurrency test (fixture)",
        initialManifest: empty,
        idempotencyKey: key(),
      });
      expect(created.ok).toBe(true);

      const writers = 6;
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) => {
          const manifest = structuredClone(empty);
          manifest.take.name = `writer ${i}`;
          return h.backend.projects.saveRevision(h.owner.actor, {
            projectId,
            takeId,
            expectedRevision: 1,
            manifest,
            idempotencyKey: key(),
            message: `writer ${i}`,
          });
        }),
      );
      const winners = results.flatMap((r, i) => (r.ok ? [{ i, revision: r.value }] : []));
      const losers = results.filter((r) => !r.ok).map((r) => (r.ok ? null : r.error.code));
      expect(winners).toHaveLength(1);
      expect(losers).toEqual(Array(writers - 1).fill("REVISION_CONFLICT"));

      const head = await h.backend.projects.getRevision(h.owner.actor, projectId, takeId);
      if (!head.ok) throw new Error(head.error.message);
      expect(head.value.number).toBe(2);
      expect(head.value.id).toBe(winners[0].revision.revisionId);
      expect(head.value.manifest.take.name).toBe(`writer ${winners[0].i}`);
    });
  });
}
