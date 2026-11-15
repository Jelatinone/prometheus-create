/**
 * The app's Backend: PostgresBackend over DATABASE_URL, one pool per server
 * process (cached on globalThis so dev hot reloads do not leak pools).
 */
import { createPool } from "./db";
import { databaseUrl } from "./env";
import { PostgresBackend } from "./postgres-backend";

const holder = globalThis as typeof globalThis & { __prometheusBackend?: PostgresBackend };

export function getBackend(): PostgresBackend {
  holder.__prometheusBackend ??= new PostgresBackend({ pool: createPool(databaseUrl()) });
  return holder.__prometheusBackend;
}
