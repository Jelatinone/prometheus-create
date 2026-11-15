"use client";

/**
 * Right inspector: object list, then the selected object's name, transform
 * (position m, rotation °, uniform scale), dimensions, geometry and evidence.
 * Numeric fields commit on Enter or blur, one undoable edit each.
 */
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { Transform, Vec3 } from "@/lib/contracts/common";
import type { TakeManifest } from "@/lib/contracts/revision";
import { objectDimensions, type SceneObject } from "@/lib/contracts/scene";
import { eulerDegToQuat, quatToEulerDeg, uniformFactor, withUniformScale } from "@/lib/editor/model";

interface Props {
  manifest: TakeManifest;
  selected: SceneObject | null;
  onSelect(id: string | null): void;
  onTransform(id: string, t: Transform): void;
  onRename(id: string, name: string): void;
  onVisible(id: string, visible: boolean): void;
}

const fmt = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : "–");

/** Draft text for one number; the parent keys it by value, so an outside change resets the draft. */
function NumberField(props: { label: string; value: number; digits?: number; onCommit(v: number): void; min?: number }) {
  return <NumberDraft key={fmt(props.value, props.digits ?? 3)} {...props} />;
}

function NumberDraft({ label, value, digits = 3, onCommit, min }: { label: string; value: number; digits?: number; onCommit(v: number): void; min?: number }) {
  const [text, setText] = useState(fmt(value, digits));
  const commitText = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v) || (min !== undefined && v <= min)) return setText(fmt(value, digits));
    if (Math.abs(v - value) > 10 ** -(digits + 1)) onCommit(v);
  };
  return (
    <label className="flex min-w-0 items-center gap-1 rounded border border-line bg-canvas px-1.5 py-0.5 focus-within:border-accent">
      <span className="text-[10px] font-semibold text-muted">{label}</span>
      <input
        className="w-full min-w-0 bg-transparent text-right font-mono text-xs outline-none"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(fmt(value, digits));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function Vec3Row({ title, value, digits, onCommit }: { title: string; value: Vec3; digits?: number; onCommit(v: Vec3): void }) {
  return (
    <div>
      <div className="mb-0.5 text-xs text-muted">{title}</div>
      <div className="grid grid-cols-3 gap-1">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <NumberField
            key={axis}
            label={axis}
            value={value[i]}
            digits={digits}
            onCommit={(v) => onCommit(value.map((old, j) => (j === i ? v : old)) as Vec3)}
          />
        ))}
      </div>
    </div>
  );
}

function NameField({ initial, onCommit }: { initial: string; onCommit(name: string): void }) {
  const [name, setName] = useState(initial);
  return (
    <label className="block">
      <span className="text-xs text-muted">Name</span>
      <input
        className="mt-0.5 w-full rounded border border-line bg-canvas px-1.5 py-1 text-sm outline-none focus:border-accent"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== initial && onCommit(name)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function Inspector({ manifest, selected, onSelect, onTransform, onRename, onVisible }: Props) {

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-y-auto rounded-xl border border-line bg-panel text-sm shadow-sm" aria-label="Inspector">
      <section className="border-b border-line p-3">
        <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Objects</h2>
        {manifest.scene.objects.length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {manifest.scene.objects.map((o) => (
              <li key={o.id} className="flex items-center gap-1">
                <button
                  className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left ${o.id === selected?.id ? "bg-ink text-canvas" : "hover:text-accent"}`}
                  onClick={() => onSelect(o.id)}
                  aria-current={o.id === selected?.id}
                >
                  {o.name}
                  {o.provenance.kind === "fixture" && <span className="ml-1 text-[10px] opacity-70">(fixture)</span>}
                </button>
                <button
                  className="grid size-6 place-items-center rounded text-muted hover:text-accent"
                  onClick={() => onVisible(o.id, !o.visible)}
                  aria-pressed={o.visible}
                  aria-label={o.visible ? `Hide ${o.name}` : `Show ${o.name}`}
                  title={o.visible ? "Hide" : "Show"}
                >
                  {o.visible ? <EyeIcon className="size-4" /> : <EyeSlashIcon className="size-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!selected ? (
        <p className="p-3 text-xs text-muted">Select an object in the viewport or the list to edit it.</p>
      ) : (
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Inspector</h2>
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-semibold" title="Edits change this take's saved scene, not a keyframe">
              Scope: Scene
            </span>
          </div>
          <NameField key={`${selected.id}:${selected.name}`} initial={selected.name} onCommit={(n) => onRename(selected.id, n)} />

          <Vec3Row title="Position (m)" value={selected.transform.position} onCommit={(p) => onTransform(selected.id, { ...selected.transform, position: p })} />
          <Vec3Row
            title="Rotation (°, XYZ)"
            value={quatToEulerDeg(selected.transform.rotation)}
            digits={1}
            onCommit={(deg) => onTransform(selected.id, { ...selected.transform, rotation: eulerDegToQuat(deg) })}
          />
          <div>
            <div className="mb-0.5 text-xs text-muted">Uniform scale</div>
            <NumberField
              label="×"
              value={uniformFactor(selected.transform)}
              min={0}
              onCommit={(f) => {
                const t = withUniformScale(selected.transform, f);
                if (t) onTransform(selected.id, t);
              }}
            />
          </div>

          <div>
            <div className="text-xs text-muted">Dimensions (m)</div>
            <div className="font-mono text-sm">{objectDimensions(selected).map((d) => fmt(d)).join(" × ")}</div>
            <div className="text-[11px] text-muted">
              {selected.dimensionsStatus === "user_confirmed" ? "User confirmed" : "Estimated: not a physical measurement"}
            </div>
          </div>

          <div className="rounded border border-line bg-canvas p-2 text-xs">
            <div className="font-semibold">Geometry</div>
            <div>Revision {selected.geometry.geometryRevision}</div>
            <div className="truncate font-mono text-[11px] text-muted" title={selected.geometry.assetId}>
              {selected.geometry.assetId}
            </div>
            <div className="text-muted">
              Source units {selected.geometry.normalization.sourceUnits}, up {selected.geometry.normalization.sourceUpAxis}, scale applied{" "}
              {selected.geometry.normalization.scaleApplied}
            </div>
          </div>

          <div className="rounded border border-line bg-canvas p-2 text-xs">
            <div className="font-semibold">Evidence</div>
            <div>
              Origin: <span className="font-medium">{selected.provenance.kind}</span>
              {selected.provenance.provider && <> · {selected.provenance.provider}</>}
            </div>
            {selected.provenance.note && <div className="text-muted">{selected.provenance.note}</div>}
            {selected.provenance.observationIds.length > 0 && <div className="text-muted">{selected.provenance.observationIds.length} source observation(s)</div>}
          </div>

          <p className="text-[11px] text-muted">Physics and joints are not in this build.</p>
        </div>
      )}
    </aside>
  );
}
