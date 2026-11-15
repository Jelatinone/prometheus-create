/**
 * Server-side configuration. Values come from the worktree's ignored
 * .env.local (dev) or the host's secret store (deploy). Nothing here may be
 * imported by a client component: SUPABASE_SECRET_KEY and DATABASE_URL never
 * reach a browser bundle.
 */

export interface SupabasePublicConfig {
  url: string;
  publishableKey: string;
}

export interface SupabaseServerConfig extends SupabasePublicConfig {
  secretKey: string;
  bucket: string;
}

export const DEFAULT_BUCKET = "project-assets";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not configured (set it in .env.local or the host's secrets)`);
  return value;
}

export function supabasePublicConfig(): SupabasePublicConfig {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    publishableKey: required(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
  };
}

export function supabaseServerConfig(): SupabaseServerConfig {
  return {
    ...supabasePublicConfig(),
    secretKey: required(
      "SUPABASE_SECRET_KEY",
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    bucket: process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET,
  };
}

export function databaseUrl(): string {
  return required("DATABASE_URL", process.env.DATABASE_URL);
}
