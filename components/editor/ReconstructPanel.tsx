"use client";

/**
 * Generate objects from one captured frame (S4 phase 1, dynamic count), as
 * three steps: 1 choose the frame, 2 describe what to find (each description
 * finds every instance in the frame, one segmentation), 3 generate the listed
 * objects and add them to the take. Job IDs are stored before each request,
 * so a reload resumes the same jobs; retries follow lib/editor/batch. Results
 * are kept per frame. Reconstructions that already exist for the frame (from a
 * FaceTime call, another browser or an earlier session) are listed and can be
 * loaded: an existing job ID only resumes on the server, so nothing is paid twice.
 */
import { ArrowPathIcon, CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, ExclamationTriangleIcon, MagnifyingGlassIcon, PlusIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { newId } from "@/lib/contracts/common";
import type { Actor, Observation, ReconstructionJob } from "@/lib/contracts";
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

export function ReconstructPanel({ api, actor, projectId, takeId, onApply, captureCount = 0, takeJobIds = [], findRef }: {
  api: HttpBackend; actor: NonNullable<Actor>; projectId: string; takeId: string;
  /** Lets the toolbar run Find objects (no prompt) on the current frame. */
  findRef?: Ref<{ findAll(): void }>;
  /** Jobs whose objects are already in the take, so they are not offered again. */
  takeJobIds?: string[];
  /** Rises when a frame is captured elsewhere on the page, so the frame list follows it. */
  captureCount?: number;
  onApply: (takeId: string, name: string, observation: Observation, outcome: ReconstructionOutcome, placement: LevelledPlacement | null) => boolean;
}) {
  const key = `prometheus:generate2:${projectId}`;
  // Results for frames other than the current one, by frame ID: changing frame never drops a job reference.
  const keptKey = `${key}:kept`;
  const [keptFrames, setKeptFrames] = useState<string[]>([]);
  // Jobs the server already holds for the chosen frame.
  const [earlier, setEarlier] = useState<ReconstructionJob[]>([]);
  const [frames, setFrames] = useState<Observation[]>([]);
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ReconstructionOutcome>>({});
  const [masks, setMasks] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [detecting, setDetecting] = useState(false);
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

  const readKept = useCallback((): Record<string, Saved> => {
    try {
      return JSON.parse(localStorage.getItem(keptKey) ?? "{}") as Record<string, Saved>;
    } catch { return {}; }
  }, [keptKey]);
  const writeKept = useCallback((kept: Record<string, Saved>) => {
    setKeptFrames(Object.keys(kept));
    try {
      if (Object.keys(kept).length) localStorage.setItem(keptKey, JSON.stringify(kept));
      else localStorage.removeItem(keptKey);
    } catch { /* storage may be disabled */ }
  }, [keptKey]);

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

  /** Makes a stored batch current: unfinished jobs resume; finished meshes re-read their job (never resubmitted). */
  const activate = useCallback((restored: Saved) => {
    const objects = restored.batch.objects.map((o) => (o.mesh?.stage === "done" && !restored.applied.includes(o.key) ? { ...o, mesh: { ...o.mesh, stage: "running" as const } } : o));
    persist({ ...restored, batch: { ...restored.batch, objects } });
    setSelected(restored.frame.id);
    for (const f of restored.batch.finds) if (f.job.stage === "pending" || f.job.stage === "running") void driveFind(f.key);
    for (const o of objects) if (o.mesh && (o.mesh.stage === "pending" || o.mesh.stage === "running")) void driveMesh(o.key);
  }, [persist, driveFind, driveMesh]);

  const refresh = useCallback(async (newest = false) => {
    const r = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${projectId}`);
    if (!alive.current) return;
    if (!r.ok) return setError(r.error.message);
    setFrames(r.value);
    // A frame captured just now becomes the choice, unless this frame already has work on it.
    setSelected((id) => (r.value.some((o) => o.id === id) && !(newest && !savedRef.current) ? id : r.value[0]?.id ?? ""));
  }, [api, actor, projectId]);
  useEffect(() => {
    if (captureCount > 0) void Promise.resolve().then(() => refresh(true));
  }, [captureCount, refresh]);

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
        setKeptFrames(Object.keys(readKept()));
        if (restored?.batch?.frame?.projectId !== projectId || !Array.isArray(restored.batch.finds)) return;
        activate(restored);
      } catch { /* unreadable saved state: start fresh */ }
    });
  }, [key, projectId, refresh, activate, readKept]);

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
  const objectMasks = [
    ...(saved?.batch.objects.map((o) => o.maskAssetId) ?? []),
    ...earlier.flatMap((j) => (j.kind === "reconstruct_object" && j.state === "succeeded" ? j.input.maskAssetIds.slice(0, 1) : [])),
  ].join(",");
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

  /** Switch to another captured frame. This frame's searches and results are kept and come back when it is chosen again. */
  function chooseFrame(id: string) {
    const s = savedRef.current;
    if (busy || id === (s?.frame.id ?? selected)) return;
    const kept = readKept();
    if (s && (s.batch.finds.length || s.batch.objects.length)) kept[s.frame.id] = s;
    const next = kept[id] ?? null;
    delete kept[id];
    writeKept(kept);
    setOutcomes({});
    setConfirm({});
    setError("");
    setPreview(null);
    if (next) activate(next);
    else {
      persist(null);
      setSelected(id);
    }
  }

  /** Bring a reconstruction the server already has into this frame's list. Its job is re-read, never resubmitted. */
  function loadEarlier(job: ReconstructionJob, label: string) {
    if (!frame || job.input.observationId !== frame.id || !job.input.maskAssetIds.length) return;
    const base = savedRef.current ?? { batch: startBatch({ id: frame.id, sourceId: frame.sourceId, projectId }, takeId), frame, applied: [] };
    const objectKey = `o_${job.id.slice(4, 16)}`;
    if (base.batch.objects.some((o) => o.key === objectKey || o.mesh?.jobId === job.id)) return;
    const object: FoundObject = { key: objectKey, findKey: "earlier", label, maskAssetId: job.input.maskAssetIds[0], removed: false, mesh: { jobId: job.id, stage: "running" } };
    setError("");
    persist({ ...base, batch: { ...base.batch, objects: [...base.batch.objects, object] } });
    void driveMesh(objectKey);
  }

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

  /** Find objects without a description: name what is in the frame, then one find per name. */
  async function findAll() {
    if (!frame || detecting) return;
    setDetecting(true);
    setError("");
    const r = await api.request<{ labels: string[] }>(actor, "POST", "/api/reconstruction", {
      projectId, sourceId: frame.sourceId, observationId: frame.id, jobId: newId("job"), action: "detect",
    });
    setDetecting(false);
    if (!r.ok) return setError(`Could not find objects: ${r.error.message}`);
    if (!r.value.labels.length) return setError("Nothing recognisable in this frame. Describe what to look for instead.");
    const base = savedRef.current ?? { batch: startBatch({ id: frame.id, sourceId: frame.sourceId, projectId }, takeId), frame, applied: [] };
    let batch = base.batch;
    for (const label of r.value.labels) batch = addFind(batch, label);
    const added = batch.finds.filter((f) => !base.batch.finds.some((g) => g.key === f.key));
    if (!added.length) return setError("Already looking for everything found in this frame.");
    persist({ ...base, batch }); // every new job ID is stored before its request
    for (const f of added) void driveFind(f.key);
  }
  useImperativeHandle(findRef, () => ({ findAll: () => void findAll() }));

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
  const frameId = frame?.id ?? "";
  useEffect(() => {
    let live = true;
    if (!frameId) return;
    void api.request<ReconstructionJob[]>(actor, "GET", `/api/jobs?projectId=${encodeURIComponent(projectId)}&observationId=${encodeURIComponent(frameId)}`).then((r) => {
      if (live) setEarlier(r.ok ? r.value : []);
    });
    return () => { live = false; };
    // Re-read when work on this frame finishes, so a job made just now is known next time.
  }, [api, actor, projectId, frameId, busy]);
  // Succeeded reconstructions for this frame, one per mesh (a splat backfill is a second job with the same mesh), oldest kept.
  const listedJobs = new Set(objects.flatMap((o) => (o.mesh ? [o.mesh.jobId, ...(o.mesh.abandonedJobIds ?? [])] : [])));
  const meshesSeen = new Set<string>();
  const earlierResults = [...earlier]
    .reverse()
    .filter((j) => j.input.observationId === frameId && j.kind === "reconstruct_object" && j.state === "succeeded" && !!j.output?.meshAssetId && j.input.maskAssetIds.length > 0)
    .filter((j) => !meshesSeen.has(j.output!.meshAssetId!) && !!meshesSeen.add(j.output!.meshAssetId!))
    .map((job, i) => ({ job, label: `Object ${i + 1}` }))
    .filter(({ job }) => !listedJobs.has(job.id));
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

  const index = frames.findIndex((o) => o.id === frame?.id);
  const stepFrame = (delta: number) => {
    const next = frames[index + delta];
    if (next) chooseFrame(next.id);
  };
  const readyToAdd = saved ? objects.filter((o) => o.mesh?.stage === "done" && outcomes[o.key] && !saved.applied.includes(o.key)) : [];
  const sameTake = !saved || saved.batch.takeId === takeId;
  const heading = "flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase";
  const number = "grid size-4.5 place-items-center rounded-full bg-accent/15 text-[10px] text-accent";

  return (
    <section className="space-y-4" aria-label="Generate objects">
      <div className="space-y-1.5">
        <h3 className={heading}><span className={number}>1</span>Frame</h3>
        {frames.length || saved ? (
          <>
            <div className="flex items-center gap-1">
              <button className={small} disabled={busy || index <= 0} onClick={() => stepFrame(-1)} title="Previous frame in the list" aria-label="Previous frame">
                <ChevronLeftIcon className="size-4" />
              </button>
              <select id="reconstruct-frame" aria-label="Captured frame" className="h-7.5 min-w-0 flex-1 rounded-md border border-line bg-panel px-1.5 text-xs" value={frame?.id ?? ""} disabled={busy} title={busy ? "Wait for the running jobs before changing frame" : "Results are kept per frame"} onChange={(e) => chooseFrame(e.target.value)}>
                {saved && !frames.some((o) => o.id === saved.frame.id) && <option value={saved.frame.id}>Frame {saved.frame.sequence}</option>}
                {frames.map((o) => <option key={o.id} value={o.id}>Frame {o.sequence} · {new Date(o.receivedAt).toLocaleTimeString()}{keptFrames.includes(o.id) ? " · has results" : ""}</option>)}
              </select>
              <button className={small} disabled={busy || index < 0 || index >= frames.length - 1} onClick={() => stepFrame(1)} title="Next frame in the list" aria-label="Next frame">
                <ChevronRightIcon className="size-4" />
              </button>
              <button className={small} onClick={() => void refresh()} title="Refresh frames" aria-label="Refresh frames">
                <ArrowPathIcon className="size-4" />
              </button>
            </div>
            {/* Signed private asset URL, refreshed whenever the frame selection changes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {preview && <img src={preview} alt="Selected captured frame" className="max-h-56 w-full rounded-lg bg-black object-contain" />}
          </>
        ) : (
          <p className="text-sm text-muted">No captured frames yet. Use Capture below.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <h3 className={heading}><span className={number}>2</span>Find objects</h3>
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <input className="h-8.5 w-full min-w-0 rounded-lg border border-line bg-panel px-2 text-sm" value={prompt} maxLength={200} placeholder={finds.length ? "Something else" : "e.g. chairs"} aria-label="What to look for" onChange={(e) => setPrompt(e.target.value)} />
          <button type="submit" className={`${button} h-8.5 shrink-0 py-0`} disabled={!frame || !prompt.trim()} title="Find every match in this frame">
            <MagnifyingGlassIcon className="size-4" />Find
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
      </div>

      {earlierResults.length > 0 && (
        <div className="space-y-1.5">
          <h3 className={heading} title="Reconstructions the project already has for this frame. Loading one starts no new job.">Already generated</h3>
          <ul className="grid grid-cols-1 gap-1.5" aria-label="Earlier results">
            {earlierResults.map(({ job, label }) => {
              const inTake = takeJobIds.includes(job.id);
              const mask = job.input.maskAssetIds[0];
              return (
                <li key={job.id} className="flex items-center gap-2 rounded-lg border border-line bg-canvas p-1.5 text-sm">
                  <span className="relative size-10 shrink-0 overflow-hidden rounded bg-black">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {preview && <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {masks[mask] && <img src={masks[mask]} alt="" className="absolute inset-0 size-full object-cover mix-blend-multiply" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{label}</span>
                    <span className="block text-xs text-muted">{inTake ? "In the take" : `Generated ${new Date(job.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}</span>
                  </span>
                  {!inTake && <button className={small} disabled={busy} onClick={() => loadEarlier(job, label)} aria-label={`Load ${label}`} title="Load this result (no new job)"><ArrowPathIcon className="size-3.5" />Load</button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {saved && (objects.length > 0 || finds.length > 0) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className={heading}><span className={number}>3</span>Generate and add</h3>
            <button className="text-xs text-muted hover:text-accent disabled:opacity-40" disabled={busy} onClick={() => { persist(null); setOutcomes({}); setConfirm({}); setMasks({}); }} title="Clear this frame's searches and results. Objects already added stay in the take.">
              Clear
            </button>
          </div>
          {objects.length > 0 && (
            <ul className="grid grid-cols-1 gap-1.5" aria-label="Found objects">
              {objects.map((o) => {
                const isApplied = saved.applied.includes(o.key);
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
                          {isApplied ? "In the take" : o.mesh ? jobStatus(o.mesh, "Generating", "Ready · estimated") : o.removed ? "Skipped" : "Found"}
                        </span>
                      </span>
                      {stateIcon(o.mesh)}
                      {!o.mesh && (
                        <button className="text-muted hover:text-accent" onClick={() => update((b) => setRemoved(b, o.key, !o.removed))} aria-label={o.removed ? `Keep ${o.label}` : `Skip ${o.label}`} title={o.removed ? "Keep" : "Skip"}>
                          {o.removed ? <ArrowPathIcon className="size-4" /> : <XMarkIcon className="size-4" />}
                        </button>
                      )}
                      {ready && !isApplied && <button className={small} disabled={!sameTake} onClick={() => apply(o)}><PlusIcon className="size-3.5" />Add</button>}
                      {o.mesh?.stage === "failed" && !confirm[o.key] && <button className={small} onClick={() => retry("mesh", o.key, o.mesh!)}><ArrowPathIcon className="size-3.5" />Retry</button>}
                    </div>
                    {o.mesh && confirmBox(o.key, "mesh", o.mesh)}
                  </li>
                );
              })}
            </ul>
          )}
          {pending.length > 0 && (
            <button className={`${button} w-full bg-accent/15`} onClick={generate}>
              <SparklesIcon className="size-4" /> Generate {pending.length} {pending.length === 1 ? "object" : "objects"}
            </button>
          )}
          {readyToAdd.length > 1 && (
            <button className={`${button} w-full`} disabled={!sameTake} onClick={() => readyToAdd.forEach(apply)}>
              <PlusIcon className="size-4" /> Add all {readyToAdd.length} to the take
            </button>
          )}
          {!sameTake && <p className="text-xs text-muted">Switch back to the take that started this to add its objects.</p>}
        </div>
      )}
      {detecting && <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" /> Finding objects in this frame…</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
