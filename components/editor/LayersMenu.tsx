"use client";

import { CheckIcon, CubeIcon, SparklesIcon, Square3Stack3DIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { LayerView } from "@/lib/scene/splat";

interface Props {
  layers: LayerView;
  onChange(layers: LayerView): void;
  /** The toolbar's button class for an on/off control. */
  buttonClass(on: boolean): string;
  panelClass: string;
  /** Open upwards (for a toolbar at the bottom of the screen). */
  above?: boolean;
}

const ROWS = [
  { id: "mesh", label: "Mesh", Icon: CubeIcon },
  { id: "splat", label: "Splat", Icon: SparklesIcon },
] as const;

/** Layers pop-up (CP-018, ADR-005): independent Mesh and Splat view toggles. View state only; nothing is saved. */
export function LayersMenu({ layers, onChange, buttonClass, panelClass, above = false }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const partial = !layers.mesh || !layers.splat;
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        className={buttonClass(open || partial)}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Layers"
        title="Layers: show or hide meshes and splats"
      >
        <Square3Stack3DIcon className="size-5" />
      </button>
      {open && (
        <div role="menu" aria-label="Layers" className={`absolute z-20 w-36 p-1 ${above ? "bottom-11 left-1/2 -translate-x-1/2" : "top-10 right-0"} ${panelClass}`}>
          {ROWS.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="menuitemcheckbox"
              aria-checked={layers[id]}
              onClick={() => onChange({ ...layers, [id]: !layers[id] })}
              className={`flex h-8.5 w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-panel-2 hover:text-accent ${layers[id] ? "text-ink" : "text-muted"}`}
            >
              <Icon className="size-5" />
              <span className="flex-1 text-left">{label}</span>
              {layers[id] && <CheckIcon className="size-4 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
