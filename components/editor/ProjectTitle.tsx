"use client";

import { useState } from "react";

/** The project name in the editor header; click it to rename (Enter or blur saves, Escape cancels). */
export function ProjectTitle({ title, onRename }: { title: string; onRename: (title: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function commit() {
    if (draft === null || saving) return;
    const next = draft.trim();
    if (!next || next === title) return setDraft(null);
    setSaving(true);
    const done = await onRename(next.slice(0, 120));
    setSaving(false);
    if (done) setDraft(null);
  }

  if (draft === null)
    return (
      <button
        className="min-w-0 truncate rounded-lg px-1.5 py-1 font-serif font-semibold hover:bg-panel-2 hover:text-accent"
        onClick={() => setDraft(title)}
        title="Rename project"
        aria-label="Rename project"
      >
        {title}
      </button>
    );
  return (
    <input
      autoFocus
      value={draft}
      maxLength={120}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") setDraft(null);
      }}
      className="h-8.5 w-48 min-w-0 rounded-lg border border-line bg-canvas px-1.5 font-serif font-semibold focus:border-accent focus:outline-none"
      aria-label="Project name"
    />
  );
}
