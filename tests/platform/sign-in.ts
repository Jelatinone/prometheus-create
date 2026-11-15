/**
 * Test-user sign-in for the platform harness AND for plain scripts (tsx):
 * no vitest import here, so .verify/ and capture scripts can get a real
 * short-lived access token. Reads .env.local; never prints it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/contracts/ports";
import { actorFromAccessToken, supabaseAdmin } from "@/lib/server/auth";
import { REPO_ROOT } from "../helpers/fixtures";

const ENV_FILE = resolve(REPO_ROOT, ".env.local");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const TEST_USER_EMAILS = {
  owner: process.env.PLATFORM_TEST_USER_A_EMAIL ?? "hk003-owner@prometheus.test",
  other: process.env.PLATFORM_TEST_USER_B_EMAIL ?? "hk003-other@prometheus.test",
} as const;

export interface TestUser {
  email: string;
  actor: NonNullable<Actor>;
  accessToken: string;
}

export function publicClient(): SupabaseClient {
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
