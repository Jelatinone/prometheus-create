"use client";

import { ArchiveBoxIcon, ArrowDownTrayIcon, CubeIcon, PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type ExportFormat = "png" | "glb" | "zip";

interface Props {
  takeName: string;
  frame: number;
  animated: boolean;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  progress: ReactNode;
  onClose(): void;
  onExport(format: ExportFormat): void;
}

const formats = [
  { id: "png", label: "Image (.png)", Icon: PhotoIcon, description: "Current view and layer at the paused playhead, without editor guides." },
  { id: "glb", label: "3D scene (.glb)", Icon: CubeIcon, description: "Visible meshes at the paused playhead, in meters. Splat appearance is not included." },
  { id: "zip", label: "Project (.zip)", Icon: ArchiveBoxIcon, description: "All saved takes and their referenced assets. Import from Saves to reopen. Capture history is not included." },
] as const;

/** Local dialog chrome; export work is covered by the editor's shared overlay. */
export function ExportDialog({ takeName, frame, animated, dirty, busy, error, progress, onClose, onExport }: Props) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const panel = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = panel.current;
    dialog?.showModal(); // Native modality also isolates global account controls.
    return () => { dialog?.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    // Disabling a focused download button can move focus to the document body.
    // Keep it inside the dialog while busy and after a recoverable failure.
    if (busy) panel.current?.focus();
    else panel.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [busy]);

  return (
      <dialog
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        aria-describedby="export-description"
        aria-busy={busy}
        tabIndex={-1}
        className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-line bg-panel p-5 text-ink shadow-xl backdrop:bg-ink/25"
        onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
        onClick={(e) => {
          if (e.target !== e.currentTarget || busy) return;
          const rect = e.currentTarget.getBoundingClientRect();
          if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // Modal keystrokes must never edit or play the take.
          if (busy) { e.preventDefault(); return; }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Tab") {
            const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("button:enabled, input:checked")];
            const first = controls[0];
            const last = controls.at(-1);
            const onControl = controls.includes(document.activeElement as HTMLElement);
            if (e.shiftKey && (document.activeElement === first || !onControl)) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !onControl)) { e.preventDefault(); first?.focus(); }
          }
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="export-title" className="font-serif text-xl">Export</h2>
          <button type="button" disabled={busy} onClick={onClose} aria-label="Close export" className="grid size-8.5 place-items-center rounded-md hover:bg-panel-2 hover:text-accent disabled:opacity-40">
            <XMarkIcon className="size-5" />
          </button>
        </div>
        <p id="export-description" className="mt-1 break-words text-sm text-muted">
          {takeName}{animated ? ` · frame ${frame}` : " · still take"}
        </p>
        <fieldset disabled={busy} className="mt-4 space-y-2">
          <legend className="sr-only">Export format</legend>
          {formats.map(({ id, label, Icon, description }) => (
            <label key={id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-accent ${format === id ? "border-ink bg-panel-2" : "border-line hover:border-accent"}`}>
              <input className="mt-1 accent-ink" type="radio" name="export-format" value={id} checked={format === id} onChange={() => setFormat(id)} />
              <Icon className="mt-0.5 size-5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="mt-1 block text-xs text-muted">{description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {format === "zip" && dirty && <p className="mt-3 text-sm text-bad">Save your current changes before exporting the project.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="h-8.5 rounded-md border border-line px-3 text-sm hover:border-accent hover:text-accent disabled:opacity-40">Cancel</button>
          <button type="button" disabled={busy || (format === "zip" && dirty)} onClick={() => onExport(format)} className="flex h-8.5 items-center gap-2 rounded-md border border-ink bg-ink px-3 text-sm text-canvas hover:border-accent hover:bg-accent disabled:opacity-40">
            <ArrowDownTrayIcon className="size-4" />Download
          </button>
        </div>
        {progress}
      </dialog>
  );
}
