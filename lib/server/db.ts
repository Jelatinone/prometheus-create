/**
 * PostgreSQL (TigerData) connection pool and transaction helper.
 *
 * TLS is always verified. TigerData's connection strings carry
 * `sslmode=require`; node-postgres would read that too, so it is stripped and
 * replaced by an explicit `ssl` config that verifies the server certificate
 * against Node's trust store, plus `DATABASE_CA_CERT` (PEM text or a path to
 * a PEM file) when the service still presents its interim private CA.
 */
import { existsSync, readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import pg from "pg";
import type { Result } from "@/lib/contracts/common";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  /** Max pooled connections. Serverless hosts want a small number. */
  max?: number;
  /** Extra trusted CA (PEM text or file path). Defaults to DATABASE_CA_CERT. */
  ca?: string;
}

function resolveCa(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("-----BEGIN CERTIFICATE-----")) return value.replaceAll("\\n", "\n");
  if (existsSync(value)) return readFileSync(value, "utf8");
  throw new Error("DATABASE_CA_CERT is neither PEM text nor a readable file path");
}

export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  const url = new URL(connectionString);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  for (const param of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(param);
  const pinned = resolveCa(options.ca ?? process.env.DATABASE_CA_CERT);
  // `ca` replaces Node's trust store, so keep the public roots alongside the
  // pin: the connection keeps verifying after TigerData rotates to a
  // publicly signed certificate.
  const ca = pinned ? [...rootCertificates, pinned] : undefined;
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: localHost ? undefined : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: options.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
}

/**
 * Run `fn` inside BEGIN/COMMIT. An `ok: false` result rolls back (nothing
 * from a rejected command is persisted); a thrown error rolls back and
 * rethrows.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<Result<T>>,
): Promise<Result<T>> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query(result.ok ? "commit" : "rollback");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Postgres SQLSTATE of a driver error, if any. */
export function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export const UNIQUE_VIOLATION = "23505";
