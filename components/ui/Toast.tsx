"use client";

import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Presence } from "./Presence";

/**
 * A short hint that fades out on its own, or at once from its close button.
 * Key it by its text so a different hint shows again.
 */
export function Toast({ text, ms = 5000 }: { text: string; ms?: number }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return (
    <Presence
      show={open}
      role="status"
      className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-ink shadow"
    >
      <span>{text}</span>
      <button className="text-muted hover:text-accent" onClick={() => setOpen(false)} aria-label="Dismiss" title="Dismiss">
        <XMarkIcon className="size-4" />
      </button>
    </Presence>
  );
}
