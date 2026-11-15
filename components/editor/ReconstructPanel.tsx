"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newId, type Actor, type Observation } from "@/lib/contracts";
import type { HttpBackend } from "@/lib/platform/http-backend";
import type { ReconstructionOutcome, SegmentationOutcome } from "@/lib/reconstruction/runner";
import { Spinner } from "@/components/ui/Loading";

interface Pending {
  frame: Observation; takeId: string; prompt: string; segmentId: string; meshId: string;
  stage: "segment" | "reconstruct";
  maskAssetIds?: string[];
}
type Outcome = ReconstructionOutcome | SegmentationOutcome;

export function ReconstructPanel({ api, actor, projectId, takeId, onApply }: {
  api: HttpBackend; actor: NonNullable<Actor>; projectId: string; takeId: string;
  onApply: (takeId: string, name: string, observation: Observation, outcome: ReconstructionOutcome) => boolean;
}) {
  const key = `prometheus:reconstruction:${projectId}`;
  const [frames, setFrames] = useState<Observation[]>([]);
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<ReconstructionOutcome | null>(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const r = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${projectId}`);
    if (!alive.current) return;
    if (!r.ok) return setError(r.error.message);
    setFrames(r.value);
    setSelected(id => r.value.some(o => o.id === id) ? id : r.value[0]?.id ?? "");
  }, [api, actor, projectId]);
  useEffect(() => {
    // Hydrate the external browser store after mount, alongside the asynchronous frame read.
    void Promise.resolve().then(() => {
      if (!alive.current) return;
      void refresh();
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const saved = JSON.parse(raw) as Pending;
          if (saved.frame?.projectId === projectId && saved.segmentId && saved.meshId) setPending(saved);
        }
      } catch { /* Storage can be disabled; current-session work still functions. */ }
    });
  }, [key, projectId, refresh]);
  const frame = frames.find(o => o.id === selected);
  useEffect(() => {
    let live = true;
    if (!frame) return;
    void api.assetDownload(actor, projectId, frame.frame.assetId).then(r => {
      if (live) setPreview(r.ok ? r.value.download?.url ?? null : null);
    });
    return () => { live = false; };
  }, [api, actor, projectId, frame]);

  function remember(p: Pending) {
    setPending(p);
    localStorage.setItem(key, JSON.stringify(p));
  }

  async function run(p: Pending) {
    if (running.current) return;
    running.current = true; setWorking(true); setError(""); setResult(null);
    try {
      remember(p); // Save IDs before any paid submission or network request.
      let stage = p.stage;
      let masks: string[] | undefined = p.maskAssetIds;
      let action: string = stage; // Same durable job ID: the server resumes if it already exists.
      while (alive.current) {
        setStatus(stage === "segment" ? "Finding the object…" : "Reconstructing mesh…");
        const response = await api.request<Outcome>(actor, "POST", "/api/reconstruction", {
          projectId, sourceId: p.frame.sourceId, observationId: p.frame.id,
          jobId: stage === "segment" ? p.segmentId : p.meshId, action,
          ...(action === "segment" ? { prompt: p.prompt } : {}),
          ...(action === "reconstruct" ? { maskAssetIds: masks } : {}),
        });
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
        const value = response.value;
        if (!alive.current) break;
        if (value.job.state === "failed" || value.job.state === "canceled") throw new Error(value.job.error?.message ?? "Job canceled");
        if (value.job.state === "succeeded") {
          if (stage === "segment") {
            masks = (value as SegmentationOutcome).maskAssets.map(a => a.id).slice(0, 1);
            if (!masks.length) throw new Error("No object found. Choose a clearer frame or description.");
            p = { ...p, stage: "reconstruct", maskAssetIds: masks }; remember(p); stage = "reconstruct"; action = "reconstruct";
            continue;
          }
          setResult(value as ReconstructionOutcome); setStatus("Mesh ready. Add it to the take, then save."); break;
        }
        setStatus(`${stage === "segment" ? "Finding object" : "Reconstructing"}: ${value.job.state}`);
        action = "poll";
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { running.current = false; if (alive.current) setWorking(false); }
  }

  const button = "rounded-lg border border-line px-3 py-2 text-sm hover:text-accent disabled:opacity-40";
  return <section className="space-y-3" aria-label="Reconstruct an object">
    <p className="text-xs text-muted">Choose a captured frame and describe one object. Geometry and dimensions are estimated; this does not reconstruct a whole room.</p>
    <div className="flex items-center justify-between"><label htmlFor="reconstruct-frame" className="text-sm">Captured frame</label><button className={button} disabled={working} onClick={() => void refresh()}>Refresh frames</button></div>
    <select id="reconstruct-frame" className="w-full rounded-lg border border-line bg-panel p-2 text-sm" value={selected} disabled={working} onChange={e => { setSelected(e.target.value); setPreview(null); }}>
      {!frames.length && <option value="">Capture or upload a photo first</option>}
      {frames.map(o => <option key={o.id} value={o.id}>Frame {o.sequence} · {o.frame.width}×{o.frame.height} · {new Date(o.receivedAt).toLocaleTimeString()}</option>)}
    </select>
    {/* Signed private asset URL, refreshed whenever the frame selection changes. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {preview && <img src={preview} alt="Selected captured frame" className="max-h-56 w-full rounded-lg bg-black object-contain" />}
    <label className="block text-sm">Object description<input className="mt-1 w-full rounded-lg border border-line bg-panel p-2" value={prompt} maxLength={200} placeholder="e.g. the folding table" disabled={working} onChange={e => setPrompt(e.target.value)} /></label>
    <button className={`${button} w-full bg-accent/15`} disabled={working || !frame || !prompt.trim() || !!pending} onClick={() => frame && void run({ frame, takeId, prompt: prompt.trim(), segmentId: newId("job"), meshId: newId("job"), stage: "segment" })}>Reconstruct</button>
    {pending && !result && <button className={button} disabled={working} onClick={() => void run(pending)}>Resume saved job</button>}
    {working && <div className="flex items-center gap-2 text-sm"><Spinner className="size-4 border-2" /><span role="status">{status}</span></div>}
    {!working && status && <p role="status" className="text-sm">{status}</p>}
    {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    {result && pending && <button className={`${button} w-full`} disabled={takeId !== pending.takeId} onClick={() => {
      if (onApply(pending.takeId, pending.prompt, pending.frame, result)) { localStorage.removeItem(key); setPending(null); setResult(null); setStatus("Added to the take. Save to keep the mesh."); }
    }}>Add mesh to take</button>}
    {pending && pending.takeId !== takeId && <p className="text-xs text-muted">Switch back to the requesting take to add this mesh.</p>}
    {pending && !working && <details className="text-xs text-muted"><summary>Job details</summary><p className="break-all">{pending.stage === "segment" ? pending.segmentId : pending.meshId}</p><p>Resume checks the existing request. Starting over may incur another provider charge.</p><button className={button} onClick={() => { localStorage.removeItem(key); setPending(null); setResult(null); setStatus(""); setError(""); }}>Start a separate reconstruction</button></details>}
  </section>;
}
