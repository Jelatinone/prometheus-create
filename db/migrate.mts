/**
 * Apply db/migrations to TigerData.
 *
 *   npm run db:migrate            # DATABASE_URL (app database)
 *   npm run db:migrate -- --test  # TEST_DATABASE_URL (dedicated test database)
 *
 * Reads .env.local when present. Prints only the target's host, never secrets.
 */
import { existsSync } from "node:fs";
import { createPool } from "../lib/server/db";
import { runMigrations } from "../lib/server/migrations";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const target = process.argv.includes("--test") ? "TEST_DATABASE_URL" : "DATABASE_URL";
const url = process.env[target];
if (!url) {
  console.error(`${target} is not set (expected in .env.local)`);
  process.exit(1);
}

const pool = createPool(url, { max: 1 });
try {
  const host = new URL(url).hostname.replace(/^[^.]+/, "<service>");
  const report = await runMigrations(pool);
  console.log(`${target} (${host}): applied ${report.applied.length} [${report.applied.join(", ")}], already applied ${report.skipped.length}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
