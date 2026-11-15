/**
 * The app's Backend: PostgresBackend over DATABASE_URL, one pool per server
 * process (cached on globalThis so dev hot reloads do not leak pools).
 */
import { createPool } from "./db";
import { databaseUrl } from "./env";
import { PostgresBackend } from "./postgres-backend";

const holder = globalThis as typeof globalThis & {
  __prometheusBackend?: PostgresBackend;
  __prometheusPool?: ReturnType<typeof createPool>;
};

export function getBackend(): PostgresBackend {
  // A dev hot reload replaces the PostgresBackend class. A cached instance of the old class would lack
  // newly added methods (and fail every call to them), so rebuild it on the same pool.
  if (!(holder.__prometheusBackend instanceof PostgresBackend)) {
    holder.__prometheusPool ??= createPool(databaseUrl());
    holder.__prometheusBackend = new PostgresBackend({ pool: holder.__prometheusPool });
  }
  return holder.__prometheusBackend;
}
