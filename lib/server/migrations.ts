/**
 * Minimal forward-only migration runner for db/migrations/*.sql.
 *
 * Files apply in name order, each in its own transaction, under an advisory
 * lock so concurrent runners (tests, deploys) cannot interleave. Applied
 * files are recorded with a checksum; editing an applied file is an error
 * (write a new migration instead).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "./db";

export const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

/** Arbitrary constant advisory-lock key reserved for migrations. */
const LOCK_KEY = "4848303033214947";

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}

export async function runMigrations(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationReport> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const report: MigrationReport = { applied: [], skipped: [] };
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      version    text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>("select version, checksum from schema_migrations")).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = readFileSync(resolve(dir, file), "utf8");
      const sum = checksum(sql);
      const prior = done.get(file);
      if (prior) {
        if (prior !== sum) throw new Error(`migration ${file} changed after it was applied; add a new migration instead`);
        report.skipped.push(file);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [file, sum]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
      report.applied.push(file);
    }
    return report;
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
