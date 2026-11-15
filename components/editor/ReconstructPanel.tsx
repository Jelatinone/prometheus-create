"use client";

/**
 * Generate objects from one captured frame (S4 phase 1): 1–3 descriptions run
 * as independent child jobs on the existing single-mask API. Job IDs are
 * stored before any request, so a reload resumes the same jobs; retry follows
 * lib/editor/batch (never resubmits a job the provider accepted).
 */
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, PlusIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, Observation } from "@/lib/contracts";
import { MAX_BATCH, childStatus, retryChild, runChild, startBatch, type Batch, type BatchChild, type Send } from "@/lib/editor/batch";
import type { HttpBackend } from "@/lib/platform/http-backend";
import type { ReconstructionOutcome } from "@/lib/reconstruction/runner";
import { Spinner } from "@/components/ui/Loading";

/**
 * Jobs with a driver loop in this page. Module-level so a development double mount
 * (or a second panel) never drives the same job twice.
 */
const activeJobs = new Set<string>();
const jobOf = (c: BatchChild) => (c.stage === "segment" ? c.segmentJobId : c.meshJobId);

interface Saved {
  batch: Batch;
  frame: Observation;
  applied: string[];
}

export function ReconstructPanel({ api, actor, projectId, takeId, onApply }: {
  api: HttpBackend; actor: NonNullable<Actor>; projectId: string; takeId: string;
  onApply: (takeId: string, name: string, observation: Observation, outcome: ReconstructionOutcome) => boolean;
}) {
  const key = `prometheus:generate:${projectId}`;
  const [frames, setFrames] = useState<Observation[]>([]);
  const [selected, setSelected] = useState("");
  const [prompts, setPrompts] = useState<string[]>([""]);
  const [preview, setPreview] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ReconstructionOutcome>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const alive = useRef(true);
  const savedRef = useRef<Saved | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const persist = useCallback((next: Saved | null) => {
    savedRef.current = next;
    setSaved(next);
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch { /* storage may be disabled; the current session still works */ }
  }, [key]);

  const send: Send = useCallback((command) => api.request(actor, "POST", "/api/reconstruction", command), [api, actor]);

  /** Runs one child to ready/failed, saving every state change (IDs are already saved). */
  const drive = useCallback(async (child: BatchChild) => {
    const current = savedRef.current;
    const job = jobOf(child);
    if (!current || activeJobs.has(job)) return;
    activeJobs.add(job);
    setRunning((r) => ({ ...r, [child.key]: true }));
    await runChild(send, current.batch, child, {
      alive: () => alive.current,
      onUpdate: (next, outcome) => {
        const s = savedRef.current;
        if (!s) return;
        persist({ ...s, batch: { ...s.batch, children: s.batch.children.map((c) => (c.key === next.key ? next : c)) } });
        if (outcome) setOutcomes((o) => ({ ...o, [next.key]: outcome }));
      },
    });
    activeJobs.delete(job);
    if (alive.current) setRunning((r) => ({ ...r, [child.key]: false }));
  }, [send, persist]);

  const refresh = useCallback(async () => {
    const r = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${projectId}`);
    if (!alive.current) return;
    if (!r.ok) return setError(r.error.message);
    setFrames(r.value);
    setSelected((id) => (r.value.some((o) => o.id === id) ? id : r.value[0]?.id ?? ""));
  }, [api, actor, projectId]);

  // After mount: frames, and any saved batch (ready children re-read their finished job; nothing is resubmitted).
  useEffect(() => {
    void Promise.resolve().then(() => {
      if (!alive.current) return;
      void refresh();
      try {
        const raw = localStorage.getItem(key);
        let restored = raw ? (JSON.parse(raw) as Saved) : null;
        // A job saved by the earlier single-object panel continues as a one-child batch (same job IDs).
        const legacyKey = `prometheus:reconstruction:${projectId}`;
        const legacy = !restored ? localStorage.getItem(legacyKey) : null;
        if (legacy) {
          const p = JSON.parse(legacy) as { frame: Observation; takeId: string; prompt: string; segmentId: string; meshId: string; stage: "segment" | "reconstruct"; maskAssetIds?: string[] };
          if (p.frame?.projectId === projectId && p.segmentId && p.meshId) {
            const child: BatchChild = { key: "c0", prompt: p.prompt, stage: p.stage, segmentJobId: p.segmentId, meshJobId: p.meshId, maskAssetIds: p.maskAssetIds };
            restored = { batch: { id: `batch_${p.meshId.slice(4)}`, frame: { id: p.frame.id, sourceId: p.frame.sourceId, projectId }, takeId: p.takeId, children: [child] }, frame: p.frame, applied: [] };
          }
          localStorage.removeItem(legacyKey);
        }
        if (restored?.batch?.frame?.projectId !== projectId) return;
        const children = restored.batch.children.map((c) => (c.stage === "ready" && !restored.applied.includes(c.key) ? { ...c, stage: "reconstruct" as const } : c));
        persist({ ...restored, batch: { ...restored.batch, children } });
        for (const c of children) if (c.stage === "segment" || c.stage === "reconstruct") void drive(c);
      } catch { /* unreadable saved state: start fresh */ }
    });
  }, [key, projectId, refresh, persist, drive]);

  const frame = frames.find((o) => o.id === selected);
  useEffect(() => {
    let live = true;
    if (!frame) return;
    void api.assetDownload(actor, projectId, frame.frame.assetId).then((r) => {
      if (live) setPreview(r.ok ? r.value.download?.url ?? null : null);
    });
    return () => { live = false; };
  }, [api, actor, projectId, frame]);

  function generate() {
    if (!frame) return;
    const batch = startBatch({ id: frame.id, sourceId: frame.sourceId, projectId }, takeId, prompts);
    if (!batch) return setError("Describe at least one object.");
    setError("");
    setOutcomes({});
    persist({ batch, frame, applied: [] }); // every job ID is stored before the first request
    for (const c of batch.children) void drive(c);
  }

  function retry(child: BatchChild, confirmNewCharge = false) {
    const decision = retryChild(child, { confirmNewCharge });
    if ("needsConfirmation" in decision) return setConfirm((m) => ({ ...m, [child.key]: decision.reason }));
    setConfirm((m) => ({ ...m, [child.key]: "" }));
    const s = savedRef.current;
    if (!s) return;
    persist({ ...s, batch: { ...s.batch, children: s.batch.children.map((c) => (c.key === child.key ? decision.child : c)) } });
    void drive(decision.child);
  }

  function apply(child: BatchChild) {
    const s = savedRef.current;
    const outcome = outcomes[child.key];
    if (!s || !outcome) return;
    if (!onApply(s.batch.takeId, child.prompt, s.frame, outcome)) return;
    const applied = [...s.applied, child.key];
    const done = s.batch.children.every((c) => applied.includes(c.key) || c.stage === "failed");
    persist(done && s.batch.children.every((c) => applied.includes(c.key)) ? null : { ...s, applied });
  }

  const anyRunning = Object.values(running).some(Boolean);
  const button = "flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm hover:text-accent disabled:opacity-40";
  const small = "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:text-accent disabled:opacity-40";

  return (
    <section className="space-y-3" aria-label="Generate objects">
      <p className="text-xs text-muted">Choose a captured frame and describe up to {MAX_BATCH} objects in it. Each becomes its own estimated mesh; hidden surfaces and scale are inferred.</p>
      <div className="flex items-center justify-between">
        <label htmlFor="reconstruct-frame" className="text-sm">Captured frame</label>
        <button className={small} disabled={!!saved} onClick={() => void refresh()} title="Refresh frames" aria-label="Refresh frames">
          <ArrowPathIcon className="size-4" />
        </button>
      </div>
      <select id="reconstruct-frame" className="w-full rounded-lg border border-line bg-panel p-2 text-sm" value={selected} disabled={!!saved} onChange={(e) => { setSelected(e.target.value); setPreview(null); }}>
        {!frames.length && <option value="">Capture or upload a photo first</option>}
        {frames.map((o) => <option key={o.id} value={o.id}>Frame {o.sequence} · {o.frame.width}×{o.frame.height} · {new Date(o.receivedAt).toLocaleTimeString()}</option>)}
      </select>
      {/* Signed private asset URL, refreshed whenever the frame selection changes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img src={preview} alt="Selected captured frame" className="max-h-56 w-full rounded-lg bg-black object-contain" />}

      {!saved && (
        <>
          <div className="space-y-1.5">
            <span className="text-sm">Objects</span>
            {prompts.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input className="w-full rounded-lg border border-line bg-panel p-2 text-sm" value={p} maxLength={200} placeholder={i === 0 ? "e.g. the folding table" : "another object"} aria-label={`Object ${i + 1}`}
                  onChange={(e) => setPrompts((ps) => ps.map((q, j) => (j === i ? e.target.value : q)))} />
                {prompts.length > 1 && (
                  <button className="text-muted hover:text-accent" aria-label={`Remove object ${i + 1}`} onClick={() => setPrompts((ps) => ps.filter((_, j) => j !== i))}>
                    <XMarkIcon className="size-4" />
                  </button>
                )}
              </div>
            ))}
            {prompts.length < MAX_BATCH && (
              <button className={small} onClick={() => setPrompts((ps) => [...ps, ""])}>
                <PlusIcon className="size-3.5" /> Add object
              </button>
            )}
          </div>
          <button className={`${button} w-full bg-accent/15`} disabled={!frame || !prompts.some((p) => p.trim())} onClick={generate}>
            <SparklesIcon className="size-4" /> Generate {prompts.filter((p) => p.trim()).length > 1 ? `${prompts.filter((p) => p.trim()).length} objects` : "object"}
          </button>
        </>
      )}

      {saved && (
        <ul className="space-y-2" aria-label="Generation jobs">
          {saved.batch.children.map((c) => {
            const isApplied = saved.applied.includes(c.key);
            const ready = c.stage === "ready" && !!outcomes[c.key];
            return (
              <li key={c.key} className="rounded-lg border border-line bg-canvas p-2 text-sm" data-stage={c.stage}>
                <div className="flex items-center gap-2">
                  {running[c.key] ? <Spinner className="size-4 border-2" /> : c.stage === "failed" ? <ExclamationTriangleIcon className="size-4 text-bad" /> : c.stage === "ready" ? <CheckCircleIcon className="size-4 text-ok" /> : null}
                  <span className="min-w-0 flex-1 truncate font-medium">{c.prompt}</span>
                  {ready && !isApplied && <button className={small} disabled={saved.batch.takeId !== takeId} onClick={() => apply(c)}>Add to take</button>}
                  {isApplied && <span className="text-xs text-ok">Added</span>}
                  {c.stage === "failed" && !running[c.key] && !confirm[c.key] && <button className={small} onClick={() => retry(c)}><ArrowPathIcon className="size-3.5" />Retry</button>}
                </div>
                <p role="status" className={`mt-0.5 text-xs ${c.stage === "failed" ? "text-bad" : "text-muted"}`}>{isApplied ? "Added to the take. Save to keep it." : childStatus(c)}</p>
                {confirm[c.key] && (
                  <div className="mt-1.5 rounded-md border border-line bg-panel p-1.5 text-xs">
                    <p>{confirm[c.key]}</p>
                    <div className="mt-1 flex gap-1.5">
                      <button className={small} onClick={() => retry(c, true)}>Start a new job</button>
                      <button className={small} onClick={() => setConfirm((m) => ({ ...m, [c.key]: "" }))}>Keep failed</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {saved && saved.batch.takeId !== takeId && <p className="text-xs text-muted">Switch back to the requesting take to add these objects.</p>}
      {saved && !anyRunning && (
        <button className={`${small} w-full justify-center`} onClick={() => { persist(null); setOutcomes({}); setConfirm({}); }}>
          Clear these jobs and start another
        </button>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
