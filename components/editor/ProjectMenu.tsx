"use client";
import { EllipsisHorizontalIcon, PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ProjectMenu({ title, disabled, onRename, onDelete }: { title: string; disabled: boolean; onRename(): void; onDelete(): void }) {
  const [at, setAt] = useState<{left: number; top: number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setAt(null); trigger.current?.focus(); } };
    const scroll = () => setAt(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", scroll);
    window.addEventListener("scroll", scroll, true);
    menu.current?.querySelector("button")?.focus();
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); window.removeEventListener("resize", scroll); window.removeEventListener("scroll", scroll, true); };
  }, [at]);
  return <>
    <button ref={trigger} aria-label={`Actions for ${title}`} title="Project actions" aria-haspopup="menu" aria-expanded={!!at} disabled={disabled} className="grid size-8.5 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40" onClick={() => { const r = trigger.current!.getBoundingClientRect(); setAt(at ? null : { left: Math.max(8, Math.min(r.right - 160, innerWidth - 168)), top: Math.min(r.bottom + 4, innerHeight - 112) }); }}><EllipsisHorizontalIcon className="size-5" /></button>
    {at && createPortal(<div ref={menu} role="menu" aria-label={`Actions for ${title}`} style={at} className="fixed z-[70] w-40 rounded-xl border border-line bg-panel p-1.5 text-sm shadow-lg">
      <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-panel-2" onClick={() => { setAt(null); onRename(); }}><PencilIcon className="size-4" />Rename</button>
      <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-bad hover:bg-panel-2" onClick={() => { setAt(null); onDelete(); }}><TrashIcon className="size-4" />Delete</button>
    </div>, document.body)}
  </>;
}
