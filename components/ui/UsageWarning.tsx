"use client";

import { useEffect, useState } from "react";
import { Presence } from "./Presence";

const KEY = "prometheus:usage-warning-ok";
const HOLD_SECONDS = 3;

/**
 * First-visit notice that the app spends real money on paid APIs (USAGE_WARNING=on).
 * The button stays disabled for a few seconds so it cannot be skipped by accident.
 * Acknowledgement is remembered in this browser only.
 */
export function UsageWarning() {
  const [open, setOpen] = useState(false);
  const [wait, setWait] = useState(HOLD_SECONDS);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(KEY) === "1";
    } catch {}
    if (seen) return;
    const show = setTimeout(() => setOpen(true), 0);
    const tick = setInterval(() => setWait((w) => (w > 0 ? w - 1 : 0)), 1000);
    return () => {
      clearTimeout(show);
      clearInterval(tick);
    };
  }, []);

  function accept() {
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
    setOpen(false);
  }

  return (
    <Presence show={open} enter="animate-fade" className="fixed inset-0 z-[100] grid place-items-center bg-ink/30 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="usage-warning-title" className="w-full max-w-md animate-pop rounded-xl border border-line bg-panel p-6 text-ink shadow-xl">
        <h2 id="usage-warning-title" className="font-serif text-2xl font-semibold">
          Please be nice..
        </h2>
        <p className="mt-3 text-sm leading-relaxed">
          This hackathon project is connected to several paid APIs. If you are not a <span className="font-semibold text-accent">judge</span>, feel free
          to use the project, but refrain from excessive usage.
        </p>
        <p className="mt-3 text-sm leading-relaxed">
          Lastly, make sure to connect with me on{" "}
          <a
            href="https://www.linkedin.com/in/cody-washington-05468a3b5"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            LinkedIn
          </a>
          !
        </p>
        <button
          className="mt-6 w-full rounded-lg bg-ink px-4 py-2 font-medium text-canvas hover:bg-accent disabled:cursor-not-allowed disabled:bg-muted disabled:hover:bg-muted"
          disabled={wait > 0}
          onClick={accept}
          autoFocus
        >
          {wait > 0 ? `Okay, I understand (${wait})` : "Okay, I understand"}
        </button>
      </div>
    </Presence>
  );
}
