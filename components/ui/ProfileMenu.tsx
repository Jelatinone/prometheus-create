"use client";

/**
 * The account button, fixed in the top-right corner of every screen once
 * signed in. Click or tap opens a small menu: who is signed in and Sign
 * out. Personal settings can join this menu later.
 */
import { ArrowRightStartOnRectangleIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/platform/supabase-browser";

export function ProfileMenu() {
  const [email, setEmail] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useEffect(() => {
    const supabase = supabaseBrowser();
    let live = true;
    void supabase.auth.getClaims().then(({ data }) => {
      if (!live) return;
      setSignedIn(typeof data?.claims?.sub === "string");
      setEmail(typeof data?.claims?.email === "string" ? data.claims.email : null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
      setEmail(session?.user.email ?? null);
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (!signedIn) return null;
  return (
    // 34 px like the other header controls (text-sm buttons), centred in the
    // 68 px saves header and on the editor's 44 px toolbars (top-3 + 5 px).
    <div ref={root} className="profile-menu group fixed top-4.25 right-4.25 z-50" onPointerEnter={e => { if (e.pointerType === "mouse") setOpen(true); }} onPointerLeave={e => { if (e.pointerType === "mouse" && !root.current?.contains(document.activeElement)) setOpen(false); }} onKeyDown={e => { if (e.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); } }}>
      <button
        className="grid size-8.5 place-items-center rounded-md border border-line bg-panel text-ink hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <UserCircleIcon className="size-5" />
      </button>
      <div
        role="menu"
        hidden={!open}
        className="absolute right-0 top-full w-60 max-w-[calc(100vw-2rem)] pt-2"
      >
        <div className="rounded-xl border border-line bg-panel p-1.5 text-sm shadow-lg">
          <p className="truncate px-2.5 py-2 text-muted" title={email ?? undefined}>
            {email ?? "Signed in"}
          </p>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-panel-2 hover:text-accent"
            >
              Sign out
              <ArrowRightStartOnRectangleIcon className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
