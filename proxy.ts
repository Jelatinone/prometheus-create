/**
 * Proxy (Next 16's middleware): keeps the Supabase session cookies fresh and
 * sends signed-out page requests under /projects to /login.
 *
 * This is an optimistic check only. API route handlers and server components
 * verify the session themselves (lib/server/auth getActor); API requests are
 * never redirected here, they answer 401 UNAUTHORIZED.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createSessionClient } from "@/lib/server/auth";

export async function proxy(request: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createSessionClient({
    getAll: () => request.cookies.getAll(),
    setAll: (cookies, headers) => {
      for (const { name, value } of cookies) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of cookies) response.cookies.set(name, value, options);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    },
  });
  // Verifies the JWT and refreshes an expired session (rewriting cookies above).
  const { data } = await supabase.auth.getClaims();
  const signedIn = typeof data?.claims?.sub === "string";

  const { pathname, search } = request.nextUrl;
  const redirectTo = (path: string, next?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = next ? `?next=${encodeURIComponent(next)}` : "";
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };
  // The app starts at sign-in; a signed-in visitor goes straight to their saves.
  if (pathname === "/") return redirectTo(signedIn ? "/projects" : "/login");
  if (!signedIn && (pathname === "/projects" || pathname.startsWith("/projects/")))
    return redirectTo("/login", pathname + search);
  if (signedIn && pathname === "/login") return redirectTo("/projects");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fixtures/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|glb)$).*)"],
};
