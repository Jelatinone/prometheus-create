/**
 * Ensure the private Supabase Storage bucket for project assets exists.
 *
 *   npm run db:storage
 *
 * Creates SUPABASE_STORAGE_BUCKET (default "project-assets") as a private
 * bucket with a 50 MB object cap, or makes an existing bucket private. Reads
 * .env.local when present; prints no secrets.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || "project-assets";
if (!url || !secret) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (expected in .env.local)");
  process.exit(1);
}

const MAX_OBJECT_BYTES = 50 * 1024 * 1024;
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const settings = { public: false, fileSizeLimit: MAX_OBJECT_BYTES, allowedMimeTypes: null };

const existing = await admin.storage.getBucket(bucket);
if (existing.data) {
  if (existing.data.public || existing.data.file_size_limit !== MAX_OBJECT_BYTES) {
    const { error } = await admin.storage.updateBucket(bucket, settings);
    if (error) throw new Error(`could not update bucket ${bucket}: ${error.message}`);
    console.log(`bucket ${bucket}: updated to private, ${MAX_OBJECT_BYTES} byte cap`);
  } else {
    console.log(`bucket ${bucket}: exists, private, ${MAX_OBJECT_BYTES} byte cap`);
  }
} else {
  const { error } = await admin.storage.createBucket(bucket, settings);
  if (error) throw new Error(`could not create bucket ${bucket}: ${error.message}`);
  console.log(`bucket ${bucket}: created (private, ${MAX_OBJECT_BYTES} byte cap)`);
}
