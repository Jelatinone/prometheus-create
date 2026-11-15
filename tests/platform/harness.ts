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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/contracts/ports";
import { actorFromAccessToken, supabaseAdmin } from "@/lib/server/auth";
import { createPool, type Pool } from "@/lib/server/db";
import { runMigrations } from "@/lib/server/migrations";
import { PostgresBackend } from "@/lib/server/postgres-backend";
import { REPO_ROOT } from "../helpers/fixtures";

const ENV_FILE = resolve(REPO_ROOT, ".env.local");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const TEST_USER_EMAILS = {
  owner: process.env.PLATFORM_TEST_USER_A_EMAIL ?? "hk003-owner@prometheus.test",
  other: process.env.PLATFORM_TEST_USER_B_EMAIL ?? "hk003-other@prometheus.test",
} as const;

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

export interface TestUser {
  email: string;
  actor: NonNullable<Actor>;
  accessToken: string;
}

export interface PlatformHarness {
  pool: Pool;
  backend: PostgresBackend;
  owner: TestUser;
  other: TestUser;
}

function publicClient(): SupabaseClient {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function findUserId(email: string): Promise<string | null> {
  const admin = supabaseAdmin();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Ensure an email-confirmed test user exists (no password; OTP only). */
export async function ensureTestUser(email: string): Promise<string> {
  const existing = await findUserId(email);
  if (existing) return existing;
  const { data, error } = await supabaseAdmin().auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { purpose: "HK-003 platform conformance test user" },
  });
  if (error || !data.user) throw new Error(`createUser(${email}) failed: ${error?.message}`);
  return data.user.id;
}

/**
 * Real one-time code for a user, generated server-side (no email is sent).
 * Supabase still verifies it like an emailed code.
 */
export async function oneTimeCode(email: string): Promise<{ code: string; tokenHash: string }> {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties) throw new Error(`generateLink(${email}) failed: ${error?.message}`);
  return { code: data.properties.email_otp, tokenHash: data.properties.hashed_token };
}

/**
 * Sign a test user in with a one-time token and return a verified access
 * token. Test files run in parallel workers and each generates a token for
 * the same users; a newer token invalidates an unverified older one, so a
 * rejected token is retried with jitter.
 */
export async function signIn(email: string, attempts = 6): Promise<TestUser> {
  for (let attempt = 1; ; attempt++) {
    const { tokenHash } = await oneTimeCode(email);
    const { data, error } = await publicClient().auth.verifyOtp({ type: "email", token_hash: tokenHash });
    if (!error && data.session) {
      const actor = await actorFromAccessToken(data.session.access_token);
      if (!actor) throw new Error(`access token for ${email} did not verify`);
      return { email, actor, accessToken: data.session.access_token };
    }
    const superseded = /invalid or has expired/i.test(error?.message ?? "");
    if (!superseded || attempt >= attempts) throw new Error(`verifyOtp(${email}) failed: ${error?.message}`);
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 750 * attempt));
  }
}

let shared: Promise<PlatformHarness> | undefined;

/** One harness per test file run: migrations and sign-ins happen once. */
export function platformHarness(): Promise<PlatformHarness> {
  shared ??= (async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!, { max: 4 });
    await runMigrations(pool);
    await Promise.all([ensureTestUser(TEST_USER_EMAILS.owner), ensureTestUser(TEST_USER_EMAILS.other)]);
    const [owner, other] = await Promise.all([signIn(TEST_USER_EMAILS.owner), signIn(TEST_USER_EMAILS.other)]);
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
