import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Suites that use tests/platform/harness.ts platformHarness() against real Supabase/TigerData. */
const PLATFORM_LIVE = [
  "tests/platform/api-live.test.ts",
  "tests/platform/blob-store-live.test.ts",
  "tests/platform/concurrency.test.ts",
  "tests/platform/http-conformance.test.ts",
  "tests/platform/postgres-conformance.test.ts",
];

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    exclude: ["node_modules/**", "toolkit/**", ".next/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "lib/**/*.test.ts", "components/**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", "toolkit/**", ".next/**", ...PLATFORM_LIVE],
        },
      },
      {
        extends: true,
        test: {
          name: "platform-live",
          include: PLATFORM_LIVE,
          // Signs the test users in once per run, and only when these files run.
          globalSetup: ["tests/platform/global-setup.ts"],
        },
      },
    ],
  },
});
