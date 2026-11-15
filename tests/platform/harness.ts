/**
 * Live harness for the platform backend: the dedicated TigerData test
 * database plus two real Supabase test users.
 *
 * - Reads the worktree's .env.local (never printed).
 * - Refuses to run against the app database (TEST_DATABASE_URL must differ
 *   from DATABASE_URL).
 * - Applies db/migrations to the test database once per run.
 * - Ensures two email-confirmed test users exist (created through the admin
 *   API), signs each in with an admin-generated one-time token, and turns
 *   the resulting access tokens into Actors through the same verifier the
 *   routes use (lib/server/auth actorFromAccessToken).
 *
 * Without the env, platformEnv().ready is false and the suites skip with a
 * visible reason (other lanes and CI have no platform credentials).
 */
import { inject } from "vitest";
import { createPool, type Pool } from "@/lib/server/db";
import { runMigrations } from "@/lib/server/migrations";
import { PostgresBackend } from "@/lib/server/postgres-backend";
import { TEST_USER_EMAILS, ensureTestUser, signIn, type TestUser } from "./sign-in";

export { TEST_USER_EMAILS, ensureTestUser, oneTimeCode, signIn, type TestUser } from "./sign-in";

const REQUIRED = [
  "TEST_DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY",
];

export function platformEnv(): { ready: true } | { ready: false; reason: string } {
  const missing = REQUIRED.filter((names) => !names.split("|").some((n) => process.env[n]));
  if (missing.length) return { ready: false, reason: `missing ${missing.join(", ")} (.env.local)` };
  if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL)
    return { ready: false, reason: "TEST_DATABASE_URL equals DATABASE_URL; refusing to test against the app database" };
  return { ready: true };
}

export interface PlatformHarness {
  pool: Pool;
  backend: PostgresBackend;
  owner: TestUser;
  other: TestUser;
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Sessions signed in once per run by tests/platform/global-setup.ts (null without platform env). */
    platformSessions: { owner: TestUser; other: TestUser } | null;
  }
}

/** Sign both test users in once (used by the platform-live project's global setup). */
export async function signInTestUsers(): Promise<{ owner: TestUser; other: TestUser }> {
  await Promise.all([ensureTestUser(TEST_USER_EMAILS.owner), ensureTestUser(TEST_USER_EMAILS.other)]);
  const [owner, other] = await Promise.all([signIn(TEST_USER_EMAILS.owner), signIn(TEST_USER_EMAILS.other)]);
  return { owner, other };
}

/** Sessions provided by global setup, or null when it did not run (e.g. another config). */
function providedSessions(): { owner: TestUser; other: TestUser } | null {
  try {
    return inject("platformSessions") ?? null;
  } catch {
    return null;
  }
}

let shared: Promise<PlatformHarness> | undefined;

/**
 * One harness per test file: migrations run once per file, but sign-ins happen
 * once per vitest run in global setup (each test file is an isolated module
 * graph, so a per-file sign-in would repeat for every live file and race on
 * superseded one-time tokens). Falls back to signing in when no session was provided.
 */
export function platformHarness(): Promise<PlatformHarness> {
  shared ??= (async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!, { max: 4 });
    await runMigrations(pool);
    const { owner, other } = providedSessions() ?? (await signInTestUsers());
    if (owner.actor.userId === other.actor.userId) throw new Error("test users resolved to the same Supabase user");
    return { pool, backend: new PostgresBackend({ pool }), owner, other };
  })();
  return shared;
}

export async function closePlatformHarness() {
  if (!shared) return;
  const h = await shared.catch(() => null);
  shared = undefined;
  await h?.pool.end();
}
