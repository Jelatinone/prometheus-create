"use client";

import { XMarkIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import type { Camera, Keyframe, Observation, Source, TakeManifest, Transform, Vec3 } from "@/lib/contracts";
import { activeCamera, cameraTrack, captureTiming } from "@/lib/editor/camera";
import { eulerDegToQuat, quatToEulerDeg } from "@/lib/editor/model";
import { formatTakeTime, framesPerSecond } from "@/lib/editor/timeline";

export interface CaptureChoice { source: Source; observations: Observation[] }
interface Props {
  manifest: TakeManifest; camera: Camera | null; frame: number; captures: CaptureChoice[];
  onChoose(id: string): void;
  onPose(pose: Transform): void; onFov(degrees: number): void; onDuration(frames: number): void;
  onSeek(frame: number): void; onRemove(frame: number): void; onMove(from: number, to: number): void;
  onInterpolation(mode: Keyframe["interpolation"]): void; onSeed(choice: CaptureChoice): void;
  onRefreshCaptures(): void;
}

function NumberField({ name, value, onChange, digits = 3 }: { name: string; value: number; onChange(value: number): void; digits?: number }) {
  return <NumberDraft key={value} name={name} value={value} onChange={onChange} digits={digits} />;
}
function NumberDraft({ name, value, onChange, digits }: { name: string; value: number; onChange(value: number): void; digits: number }) {
  const [draft, setDraft] = useState(value.toFixed(digits));
  const canceled = useRef(false);
  return <input aria-label={name} inputMode="decimal" className="h-7 w-full min-w-0 rounded border border-line bg-canvas px-1.5 text-right font-mono text-xs outline-none focus:border-accent" value={draft}
    onChange={e => setDraft(e.target.value)} onBlur={() => {
      if (canceled.current) { canceled.current = false; return; }
      const n = Number(draft);
      if (draft.trim() && Number.isFinite(n) && n !== value) onChange(n);
      setDraft(value.toFixed(digits));
    }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { canceled.current = true; setDraft(value.toFixed(digits)); e.currentTarget.blur(); } }} />;
}

export function CameraPane(props: Props) {
  const { manifest, camera, frame, captures } = props;
  const [captureId, setCaptureId] = useState("");
  const base = activeCamera(manifest);
  const track = base ? cameraTrack(manifest, base.id) : null;
  const fps = framesPerSecond(manifest.take.frameRate);
  const choice = captures.find(c => c.source.id === captureId) ?? captures[0];
  const timing = choice ? captureTiming(choice.source, choice.observations, manifest.take.frameRate) : null;
  const estimates = choice?.observations.filter(o => o.mode === "evidence" && o.camera).length ?? 0;
  const button = "flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-2 text-xs hover:border-accent hover:text-accent disabled:opacity-40";
  const rotation = camera ? quatToEulerDeg(camera.transform.rotation) : [0, 0, 0] as Vec3;
  return <div className="space-y-4 p-3 text-sm">
    <div>
      <h2 className="font-serif font-semibold">Render camera</h2>
      {manifest.scene.cameras.length > 1 && <select aria-label="Active render camera" value={manifest.take.activeCameraId ?? ""} onChange={e => props.onChoose(e.target.value)} className="mt-2 h-8 w-full rounded-md border border-line bg-canvas px-2 text-xs">
        {!manifest.take.activeCameraId && <option value="">Choose a camera</option>}
        {manifest.scene.cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>}
      {camera && <p className="mt-2 text-xs text-muted">{camera.origin === "source_estimate" ? "Capture estimate · inferred pose" : "Authored camera"}{track ? " · edits set a key at the playhead" : " · edits change the base pose"}</p>}
    </div>
    {camera && <>
      {(["Position (m)", "Rotation (degrees)"] as const).map((title, row) => <fieldset key={title}>
        <legend className="mb-1 text-xs text-muted">{title}</legend>
        <div className="grid grid-cols-3 gap-1">{["X", "Y", "Z"].map((axis, index) => <label key={axis} className="min-w-0 text-[10px] text-muted">{axis}
          <NumberField name={`Camera ${row ? "rotation" : "position"} ${axis}`} value={(row ? rotation : camera.transform.position)[index]} digits={row ? 1 : 3} onChange={n => {
            const values = [...(row ? rotation : camera.transform.position)] as Vec3;
            values[index] = n;
            props.onPose({ ...camera.transform, ...(row ? { rotation: eulerDegToQuat(values) } : { position: values }), scale: [1, 1, 1] });
          }} />
        </label>)}</div>
      </fieldset>)}
      <label className="flex items-center justify-between gap-3 text-xs text-muted">Vertical field of view (°)
        <span className="w-20"><NumberField name="Camera field of view" value={camera.verticalFovDeg} digits={1} onChange={props.onFov} /></span>
      </label>
    </>}
    <div className="border-t border-line pt-3">
      <h3 className="font-serif font-semibold">Take duration</h3>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">Seconds<NumberField name="Take duration seconds" value={manifest.take.durationFrames / fps} onChange={n => props.onDuration(Math.round(n * fps))} /></label>
        <label className="text-xs text-muted">Frames<NumberField name="Take duration frames" digits={0} value={manifest.take.durationFrames} onChange={props.onDuration} /></label>
      </div>
      <p className="mt-1 text-[11px] text-muted">{manifest.take.frameRate.num}/{manifest.take.frameRate.den} fps</p>
    </div>
    <div className="border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-serif font-semibold">Camera keys</h3><span className="text-xs text-muted">frame {frame}</span></div>
      {track && <>
        <label className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">Position interpolation
          <select aria-label="Camera interpolation" className="h-7 rounded border border-line bg-canvas px-1" value={track.keyframes[0].interpolation} onChange={e => props.onInterpolation(e.target.value as Keyframe["interpolation"])}>
            <option value="smooth">Smooth</option><option value="linear">Linear</option><option value="step">Step</option>
          </select>
        </label>
        <ul className="mt-2 space-y-1">{track.keyframes.map(k => <li key={k.frame} className={`flex items-center gap-1 rounded border p-1 ${k.frame === frame ? "border-accent bg-panel-2" : "border-line"}`}>
          <button className="min-w-0 flex-1 truncate px-1 text-left font-mono text-xs hover:text-accent" onClick={() => props.onSeek(k.frame)} aria-label={`Go to camera key ${k.frame}`}>{formatTakeTime(k.frame, manifest.take.frameRate)}</button>
          <span className="w-16"><NumberField name={`Camera key ${k.frame} frame`} value={k.frame} digits={0} onChange={n => props.onMove(k.frame, n)} /></span>
          <button className="grid size-7 shrink-0 place-items-center rounded hover:bg-panel-2 hover:text-accent" onClick={() => props.onRemove(k.frame)} aria-label={`Remove camera key ${k.frame}`}><XMarkIcon className="size-4" /></button>
        </li>)}</ul>
      </>}
    </div>
    <div className="border-t border-line pt-3 text-xs">
      <h3 className="font-serif text-sm font-semibold">Start from capture</h3>
      {!choice ? <p className="mt-1 text-muted">No captured timing in this project.</p> : <>
        <select aria-label="Camera capture source" value={choice.source.id} onChange={e => setCaptureId(e.target.value)} className="mt-2 h-8 w-full rounded border border-line bg-canvas px-2">
          {captures.map((c, i) => <option key={c.source.id} value={c.source.id}>Capture {i + 1} · {c.source.media.kind.replaceAll("_", " ")}</option>)}
        </select>
        <button className={`${button} mt-2 w-full`} disabled={!timing} onClick={() => timing && props.onDuration(timing.frames)}>Use captured length{timing ? ` (${(timing.frames / fps).toFixed(2)} s)` : ""}</button>
        <p className="mt-1 text-muted">{timing?.label ?? (choice.source.media.kind === "image" ? "A still image has no clip duration." : "Not enough recorded timing to determine a length.")}</p>
        <button className={`${button} mt-2 w-full`} disabled={!estimates} onClick={() => props.onSeed(choice)}>Use capture camera estimates</button>
        <p className="mt-1 text-muted">{estimates ? `${estimates} recorded camera estimate(s).` : "No recorded camera poses. Camera motion stays authored."}</p>
      </>}
    </div>
  </div>;
}
