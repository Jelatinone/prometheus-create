/**
 * Identity: Supabase Auth (email OTP) -> contract Actor.
 *
 * Browsers carry the session in Supabase SSR cookies; other clients (the
 * capture agent, scripts) send `Authorization: Bearer <access token>`. Either
 * way the JWT is verified (getClaims checks the signature against the
 * project's keys, falling back to the Auth server) before its `sub` becomes
 * the Actor. Proxy only refreshes cookies; every handler calls getActor.
 */
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/contracts/ports";
import { supabasePublicConfig, supabaseServerConfig } from "./env";

/** Cookie access the SSR client needs (next/headers cookies() or a request/response pair). */
export interface CookieJar {
  getAll(): { name: string; value: string }[];
  setAll(cookies: { name: string; value: string; options: Record<string, unknown> }[], headers: Record<string, string>): void;
}

export function createSessionClient(jar: CookieJar): SupabaseClient {
  const { url, publishableKey } = supabasePublicConfig();
  return createServerClient(url, publishableKey, {
    cookies: { getAll: () => jar.getAll(), setAll: (cookies, headers) => jar.setAll(cookies, headers) },
  });
}

/** Cookie jar over next/headers cookies(), for Server Components and Route Handlers. */
export async function nextCookieJar(): Promise<CookieJar> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return {
    getAll: () => store.getAll(),
    setAll: (list) => {
      try {
        for (const { name, value, options } of list) store.set(name, value, options);
      } catch {
        // Server Components cannot write cookies; proxy.ts refreshes them instead.
      }
    },
  };
}

let tokenClient: SupabaseClient | undefined;

/** A stateless client used only to verify bearer tokens. */
function verifierClient(): SupabaseClient {
  if (!tokenClient) {
    const { url, publishableKey } = supabasePublicConfig();
    tokenClient = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return tokenClient;
}

function actorFromClaims(claims: Record<string, unknown> | null | undefined): Actor {
  const sub = claims?.sub;
  if (typeof sub !== "string" || !sub) return null;
  if (claims?.role !== "authenticated" || claims?.is_anonymous === true) return null;
  return { userId: sub };
}

/** Verify a Supabase access token and return its Actor (null when invalid/expired). */
export async function actorFromAccessToken(token: string): Promise<Actor> {
  const { data, error } = await verifierClient().auth.getClaims(token);
  if (error || !data) return null;
  return actorFromClaims(data.claims as Record<string, unknown>);
}

/** Actor from the session cookies behind `jar`. */
export async function actorFromCookies(jar: CookieJar): Promise<Actor> {
  return (await sessionUser(jar))?.actor ?? null;
}

/** The signed-in user behind `jar` (actor plus email for display), or null. */
export async function sessionUser(jar: CookieJar): Promise<{ actor: NonNullable<Actor>; email: string | null } | null> {
  const { data, error } = await createSessionClient(jar).auth.getClaims();
  if (error || !data) return null;
  const claims = data.claims as Record<string, unknown>;
  const actor = actorFromClaims(claims);
  if (!actor) return null;
  return { actor, email: typeof claims.email === "string" ? claims.email : null };
}

/** Resolve the caller of a Route Handler: bearer token first, then cookies. */
export async function getActor(request: Request): Promise<Actor> {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? actorFromAccessToken(match[1]) : null;
  }
  return actorFromCookies(await nextCookieJar());
}

let adminClient: SupabaseClient | undefined;

/** Secret-key client (server only): Storage signing and test-user admin. */
export function supabaseAdmin(): SupabaseClient {
  if (!adminClient) {
    const { url, secretKey } = supabaseServerConfig();
    adminClient = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return adminClient;
}
