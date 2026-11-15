// POST: end the session and return to the sign-in page.
import { NextResponse, type NextRequest } from "next/server";
import { createSessionClient, nextCookieJar } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
  await createSessionClient(await nextCookieJar()).auth.signOut();
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), 303);
}
