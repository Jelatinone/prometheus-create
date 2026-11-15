"use client";

/**
 * Generate objects from one captured frame (S4 phase 1, dynamic count).
 * Describe what to look for; each description finds every instance in the
 * frame (one segmentation). Found objects are listed with a cut-out preview and
 * can be removed; more descriptions can be added. Generate reconstructs
 * whatever is still listed. Job IDs are stored before each request, so a
 * reload resumes the same jobs; retries follow lib/editor/batch.
 */
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, MagnifyingGlassIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, Observation } from "@/lib/contracts";
import {
  addFind,
  findCommand,
  jobStatus,
  masksOf,
  meshCommand,
  objectsFromFind,
  retryJob,
  runJob,
  setRemoved,
  startBatch,
  startGenerate,
  toGenerate,
  type Batch,
  type FoundObject,
  type JobTrack,
  type Send,
} from "@/lib/editor/batch";
import type { HttpBackend } from "@/lib/platform/http-backend";
import type { ReconstructionOutcome } from "@/lib/reconstruction/runner";
import { levelPlacements } from "@/lib/reconstruction/placement";
import type { LevelledPlacement } from "@/lib/editor/reconstruction";
import { Spinner } from "@/components/ui/Loading";

interface Saved {
  batch: Batch;
  frame: Observation;
  applied: string[];
}

/** Jobs with a driver loop in this page; a dev double mount never drives a job twice. */
const activeJobs = new Set<string>();

export function ReconstructPanel({ api, actor, projectId, takeId, onApply }: {
  api: HttpBackend; actor: NonNullable<Actor>; projectId: string; takeId: string;
  onApply: (takeId: string, name: string, observation: Observation, outcome: ReconstructionOutcome, placement: LevelledPlacement | null) => boolean;
}) {
  const key = `prometheus:generate2:${projectId}`;
  const [frames, setFrames] = useState<Observation[]>([]);
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ReconstructionOutcome>>({});
  const [masks, setMasks] = useState<Record<string, string>>({});
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
  const update = useCallback((edit: (b: Batch) => Batch) => {
    const s = savedRef.current;
    if (s) persist({ ...s, batch: edit(s.batch) });
  }, [persist]);

  const send: Send = useCallback((command) => api.request(actor, "POST", "/api/reconstruction", command), [api, actor]);

  /** Drives one find until done, then lists one found object per mask. */
  const driveFind = useCallback(async (findKey: string) => {
    const s = savedRef.current;
    const find = s?.batch.finds.find((f) => f.key === findKey);
    if (!s || !find || activeJobs.has(find.job.jobId)) return;
    activeJobs.add(find.job.jobId);
    const setJob = (job: JobTrack) => update((b) => ({ ...b, finds: b.finds.map((f) => (f.key === findKey ? { ...f, job } : f)) }));
    const r = await runJob(send, findCommand(s.batch, find), find.job, { alive: () => alive.current, onUpdate: setJob });
    activeJobs.delete(find.job.jobId);
    if (r.job.stage === "done") update((b) => objectsFromFind(b, find, masksOf(r.outcome)));
  }, [send, update]);

  /** Drives one object's mesh job until ready or failed. */
  const driveMesh = useCallback(async (objectKey: string) => {
    const s = savedRef.current;
    const object = s?.batch.objects.find((o) => o.key === objectKey);
    if (!s || !object?.mesh || activeJobs.has(object.mesh.jobId)) return;
    activeJobs.add(object.mesh.jobId);
    const setJob = (mesh: JobTrack) => update((b) => ({ ...b, objects: b.objects.map((o) => (o.key === objectKey ? { ...o, mesh } : o)) }));
    const r = await runJob(send, meshCommand(s.batch, object), object.mesh, { alive: () => alive.current, onUpdate: setJob });
    activeJobs.delete(object.mesh.jobId);
    if (r.job.stage === "done" && r.outcome && alive.current) setOutcomes((o) => ({ ...o, [objectKey]: r.outcome as ReconstructionOutcome }));
  }, [send, update]);

  const refresh = useCallback(async () => {
    const r = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${projectId}`);
    if (!alive.current) return;
    if (!r.ok) return setError(r.error.message);
    setFrames(r.value);
    setSelected((id) => (r.value.some((o) => o.id === id) ? id : r.value[0]?.id ?? ""));
  }, [api, actor, projectId]);

  // After mount: frames, and the saved batch. Unfinished jobs resume; finished meshes re-read their job (no resubmission).
  useEffect(() => {
    void Promise.resolve().then(() => {
      if (!alive.current) return;
      void refresh();
      try {
        const raw = localStorage.getItem(key);
        let restored = raw ? (JSON.parse(raw) as Saved) : null;
        // A job saved by production's single-object panel continues here with the same job IDs (never resubmitted).
        const legacyKey = `prometheus:reconstruction:${projectId}`;
        const legacy = !restored ? localStorage.getItem(legacyKey) : null;
        if (legacy) {
          const p = JSON.parse(legacy) as { frame: Observation; takeId: string; prompt: string; segmentId: string; meshId: string; stage: "segment" | "reconstruct"; maskAssetIds?: string[] };
          if (p.frame?.projectId === projectId && p.segmentId && p.meshId) {
            const mask = p.stage === "reconstruct" ? p.maskAssetIds?.[0] : undefined;
            const batch: Batch = {
              id: `batch_${p.meshId.slice(4)}`,
              frame: { id: p.frame.id, sourceId: p.frame.sourceId, projectId },
              takeId: p.takeId,
              finds: [{ key: "f0", prompt: p.prompt, job: { jobId: p.segmentId, stage: mask ? "done" : "running" } }],
              objects: mask ? [{ key: `o_${mask.slice(4, 16)}`, findKey: "f0", label: p.prompt, maskAssetId: mask, removed: false, mesh: { jobId: p.meshId, stage: "running" } }] : [],
            };
            restored = { batch, frame: p.frame, applied: [] };
          }
          localStorage.removeItem(legacyKey);
        }
        if (restored?.batch?.frame?.projectId !== projectId || !Array.isArray(restored.batch.finds)) return;
        const objects = restored.batch.objects.map((o) => (o.mesh?.stage === "done" && !restored.applied.includes(o.key) ? { ...o, mesh: { ...o.mesh, stage: "running" as const } } : o));
        persist({ ...restored, batch: { ...restored.batch, objects } });
        setSelected(restored.frame.id);
        for (const f of restored.batch.finds) if (f.job.stage === "pending" || f.job.stage === "running") void driveFind(f.key);
        for (const o of objects) if (o.mesh && (o.mesh.stage === "pending" || o.mesh.stage === "running")) void driveMesh(o.key);
      } catch { /* unreadable saved state: start fresh */ }
    });
  }, [key, projectId, refresh, persist, driveFind, driveMesh]);

  const frame = saved?.frame ?? frames.find((o) => o.id === selected);
  useEffect(() => {
    let live = true;
    if (!frame) return;
    void api.assetDownload(actor, projectId, frame.frame.assetId).then((r) => {
      if (live) setPreview(r.ok ? r.value.download?.url ?? null : null);
    });
    return () => { live = false; };
  }, [api, actor, projectId, frame]);

  // Signed URLs for found-object masks (private assets), for the cut-out previews.
  const objectMasks = saved?.batch.objects.map((o) => o.maskAssetId).join(",") ?? "";
  useEffect(() => {
    let live = true;
    const ids = objectMasks ? objectMasks.split(",") : [];
    void Promise.all(ids.filter((id) => !masks[id]).map(async (id) => [id, await api.assetDownload(actor, projectId, id)] as const)).then((rs) => {
      if (!live) return;
      const add = Object.fromEntries(rs.flatMap(([id, r]) => (r.ok && r.value.download ? [[id, r.value.download.url]] : [])));
      if (Object.keys(add).length) setMasks((m) => ({ ...m, ...add }));
    });
    return () => { live = false; };
    // Only new mask IDs need URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectMasks, api, actor, projectId]);

  function find() {
    if (!frame) return;
    const base = savedRef.current ?? { batch: startBatch({ id: frame.id, sourceId: frame.sourceId, projectId }, takeId), frame, applied: [] };
    const next = addFind(base.batch, prompt);
    if (next === base.batch) return setError(prompt.trim() ? "Already looking for that." : "Describe what to look for.");
    setError("");
    setPrompt("");
    persist({ ...base, batch: next }); // the new job ID is stored before its request
    void driveFind(next.finds[next.finds.length - 1].key);
  }

  function generate() {
    const s = savedRef.current;
    if (!s || !toGenerate(s.batch).length) return;
    const next = startGenerate(s.batch);
    persist({ ...s, batch: next }); // every mesh job ID is stored before the first request
    for (const o of next.objects) if (o.mesh?.stage === "pending") void driveMesh(o.key);
  }

  function retry(kind: "find" | "mesh", itemKey: string, job: JobTrack, confirmNewCharge = false) {
    const decision = retryJob(job, { confirmNewCharge });
    if ("needsConfirmation" in decision) return setConfirm((m) => ({ ...m, [itemKey]: decision.reason }));
    setConfirm((m) => ({ ...m, [itemKey]: "" }));
    if (kind === "find") {
      update((b) => ({ ...b, finds: b.finds.map((f) => (f.key === itemKey ? { ...f, job: decision.job } : f)) }));
      void driveFind(itemKey);
    } else {
      update((b) => ({ ...b, objects: b.objects.map((o) => (o.key === itemKey ? { ...o, mesh: decision.job } : o)) }));
      void driveMesh(itemKey);
    }
  }

  function apply(o: FoundObject) {
    const s = savedRef.current;
    const outcome = outcomes[o.key];
    if (!s || !outcome) return;
    // Objects from one frame share the provider camera: level the batch's finished placements together
    // (Track A CP-009). Objects applied before the rest finish are not re-levelled later.
    const placed = s.batch.objects.filter((x) => outcomes[x.key]?.placement);
    const levelled = levelPlacements(placed.map((x) => outcomes[x.key]!.placement!));
    const mine = levelled[placed.findIndex((x) => x.key === o.key)];
    const placement = mine ? { position: mine.position, rotation: mine.rotation, scale: mine.scale } : null;
    if (!onApply(s.batch.takeId, o.label, s.frame, outcome, placement)) return;
    persist({ ...s, applied: [...s.applied, o.key] });
  }

  const finds = saved?.batch.finds ?? [];
  const objects = saved?.batch.objects ?? [];
  const pending = saved ? toGenerate(saved.batch) : [];
  const busy = finds.some((f) => f.job.stage === "pending" || f.job.stage === "running") || objects.some((o) => o.mesh && (o.mesh.stage === "pending" || o.mesh.stage === "running"));
  const button = "flex items-center justify-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm hover:text-accent disabled:opacity-40";
  const small = "flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:text-accent disabled:opacity-40";
  const stateIcon = (job: JobTrack | undefined) =>
    job?.stage === "pending" || job?.stage === "running" ? <Spinner className="size-4 border-2" /> : job?.stage === "failed" ? <ExclamationTriangleIcon className="size-4 text-bad" /> : job?.stage === "done" ? <CheckCircleIcon className="size-4 text-ok" /> : null;
  const confirmBox = (itemKey: string, kind: "find" | "mesh", job: JobTrack) =>
    confirm[itemKey] ? (
      <div className="mt-1.5 rounded-md border border-line bg-panel p-1.5 text-xs">
        <p>{confirm[itemKey]}</p>
        <div className="mt-1 flex gap-1.5">
          <button className={small} onClick={() => retry(kind, itemKey, job, true)}>Start a new job</button>
          <button className={small} onClick={() => setConfirm((m) => ({ ...m, [itemKey]: "" }))}>Keep failed</button>
        </div>
      </div>
    ) : null;

  return (
    <section className="space-y-3" aria-label="Generate objects">
      <p className="text-xs text-muted">Describe what to look for in a captured frame. Every match is listed; remove any you do not want, add more descriptions, then Generate. Matching is best effort, and hidden surfaces and scale are inferred.</p>
      <div className="flex items-center justify-between">
        <label htmlFor="reconstruct-frame" className="text-sm">Captured frame</label>
        <button className={small} disabled={!!saved} onClick={() => void refresh()} title="Refresh frames" aria-label="Refresh frames">
          <ArrowPathIcon className="size-4" />
        </button>
      </div>
      <select id="reconstruct-frame" className="w-full rounded-lg border border-line bg-panel p-2 text-sm" value={frame?.id ?? ""} disabled={!!saved} onChange={(e) => { setSelected(e.target.value); setPreview(null); }}>
        {!frames.length && !saved && <option value="">Capture or upload a photo first</option>}
        {saved && !frames.some((o) => o.id === saved.frame.id) && <option value={saved.frame.id}>Frame {saved.frame.sequence}</option>}
        {frames.map((o) => <option key={o.id} value={o.id}>Frame {o.sequence} · {o.frame.width}×{o.frame.height} · {new Date(o.receivedAt).toLocaleTimeString()}</option>)}
      </select>
      {/* Signed private asset URL, refreshed whenever the frame selection changes. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img src={preview} alt="Selected captured frame" className="max-h-56 w-full rounded-lg bg-black object-contain" />}

      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); find(); }}>
        <input className="w-full rounded-lg border border-line bg-panel p-2 text-sm" value={prompt} maxLength={200} placeholder={finds.length ? "Look for something else" : "What to look for, e.g. chairs"} aria-label="What to look for" onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit" className={small} disabled={!frame || !prompt.trim()} title="Find every match in this frame" aria-label="Find">
          <MagnifyingGlassIcon className="size-4" />
        </button>
      </form>

      {finds.length > 0 && (
        <ul className="space-y-1" aria-label="Searches">
          {finds.map((f) => {
            const found = objects.filter((o) => o.findKey === f.key).length;
            return (
              <li key={f.key} className="text-xs" data-stage={f.job.stage}>
                <div className="flex items-center gap-1.5">
                  {stateIcon(f.job)}
                  <span className="min-w-0 flex-1 truncate">“{f.prompt}” · {f.job.stage === "done" ? (found ? `${found} found` : "nothing found") : jobStatus(f.job, "Looking", "")}</span>
                  {f.job.stage === "failed" && !confirm[f.key] && <button className={small} onClick={() => retry("find", f.key, f.job)}><ArrowPathIcon className="size-3.5" />Retry</button>}
                </div>
                {confirmBox(f.key, "find", f.job)}
              </li>
            );
          })}
        </ul>
      )}

      {objects.length > 0 && (
        <ul className="grid grid-cols-1 gap-1.5" aria-label="Found objects">
          {objects.map((o) => {
            const isApplied = saved!.applied.includes(o.key);
            const ready = o.mesh?.stage === "done" && !!outcomes[o.key];
            return (
              <li key={o.key} className={`rounded-lg border border-line bg-canvas p-1.5 text-sm ${o.removed ? "opacity-45" : ""}`} data-stage={o.mesh?.stage ?? (o.removed ? "removed" : "found")}>
                <div className="flex items-center gap-2">
                  <span className="relative size-10 shrink-0 overflow-hidden rounded bg-black">
                    {/* Cut-out preview: the frame multiplied by this object's white-on-black mask. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {preview && <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {masks[o.maskAssetId] && <img src={masks[o.maskAssetId]} alt="" className="absolute inset-0 size-full object-cover mix-blend-multiply" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.label}</span>
                    <span role="status" className={`block text-xs ${o.mesh?.stage === "failed" ? "text-bad" : "text-muted"}`}>
                      {isApplied ? "Added to the take. Save to keep it." : o.mesh ? jobStatus(o.mesh, "Generating", "Mesh ready") : o.removed ? "Removed" : "Found"}
                    </span>
                  </span>
                  {stateIcon(o.mesh)}
                  {!o.mesh && (
                    <button className="text-muted hover:text-accent" onClick={() => update((b) => setRemoved(b, o.key, !o.removed))} aria-label={o.removed ? `Keep ${o.label}` : `Remove ${o.label}`} title={o.removed ? "Keep" : "Remove"}>
                      {o.removed ? <ArrowPathIcon className="size-4" /> : <XMarkIcon className="size-4" />}
                    </button>
                  )}
                  {ready && !isApplied && <button className={small} disabled={saved!.batch.takeId !== takeId} onClick={() => apply(o)}>Add to take</button>}
                  {o.mesh?.stage === "failed" && !confirm[o.key] && <button className={small} onClick={() => retry("mesh", o.key, o.mesh!)}><ArrowPathIcon className="size-3.5" />Retry</button>}
                </div>
                {o.mesh && confirmBox(o.key, "mesh", o.mesh)}
              </li>
            );
          })}
        </ul>
      )}

      {saved && (
        <button className={`${button} w-full bg-accent/15`} disabled={!pending.length} onClick={generate}>
          <SparklesIcon className="size-4" /> Generate
        </button>
      )}
      {saved && saved.batch.takeId !== takeId && <p className="text-xs text-muted">Switch back to the requesting take to add these objects.</p>}
      {saved && !busy && (
        <button className={`${small} w-full justify-center`} onClick={() => { persist(null); setOutcomes({}); setConfirm({}); setMasks({}); }}>
          Clear and start over
        </button>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
