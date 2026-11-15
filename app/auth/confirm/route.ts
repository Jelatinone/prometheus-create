// GET: finish an emailed sign-in link. Handles the PKCE `?code=` redirect and
// the `?token_hash=&type=` form, sets the session cookies, then redirects.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/platform/redirect";
import { createSessionClient, nextCookieJar } from "@/lib/server/auth";

const OTP_TYPES: readonly EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNext(url.searchParams.get("next"));
  const supabase = createSessionClient(await nextCookieJar());
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  let failure: string | null = "This sign-in link is incomplete.";
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failure = error ? error.message : null;
  } else if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    failure = error ? error.message : null;
  }

  const target = new URL(failure ? "/login" : next, url.origin);
  if (failure) target.searchParams.set("error", `Sign-in link failed: ${failure}`);
  return NextResponse.redirect(target);
}
