"use client";

/**
 * The persistent editor shell (PLAN §1 desktop contract, HK-004/HK-005):
 * top bar (project, take, saved state, actions), left tools, central viewport,
 * right inspector, bottom take bar, and a capture drawer. Data goes through the
 * platform client (HttpBackend + PlatformBlobStore) with the session cookie.
 */
import {
  ArrowPathIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  CameraIcon,
  CheckCircleIcon,
  CloudArrowUpIcon,
  CubeIcon,
  CursorArrowRaysIcon,
  DocumentDuplicateIcon,
  EyeIcon,
  EyeSlashIcon,
  FolderOpenIcon,
  HandRaisedIcon,
  PhotoIcon,
  SparklesIcon,
  Square2StackIcon,
  Squares2X2Icon,
  TrashIcon,
  VideoCameraIcon,
  ViewfinderCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inspectGlb } from "@/lib/assets/glb";
import { CaptureIngestor, loadProjectAsset, storeProjectAsset } from "@/lib/capture";
import { canvasEncoder } from "@/lib/capture/browser";
import { newId, type Transform } from "@/lib/contracts/common";
import type { Actor } from "@/lib/contracts/ports";
import type { Revision, TakeSummary } from "@/lib/contracts/revision";
import type { Project, SceneObject } from "@/lib/contracts/scene";
import {
  addObject,
  cleanTransform,
  commit,
  duplicateObject,
  findObject,
  redo,
  removeObject,
  renameObject,
  sameManifest,
  setObjectTransform,
  attachSplat,
  setObjectVisible,
  setSplatEnabled,
  startHistory,
  undo,
  type History,
} from "@/lib/editor/model";
import { forkTake, loadTake, nextTakeName, saveTake } from "@/lib/editor/session";
import { PlatformBlobStore } from "@/lib/platform/blob-store";
import { HttpBackend } from "@/lib/platform/http-backend";
import { EditorViewport, type Navigation, type Tool } from "@/lib/scene/viewport";
import { LoadingOverlay, LoadingScreen, Spinner } from "@/components/ui/Loading";
import { CapturePanel } from "@/components/capture/CapturePanel";
import { Inspector } from "./Inspector";
import { checkSplatPly } from "@/lib/scene/splat";
import { ReconstructPanel } from "./ReconstructPanel";
import { reconstructedObject } from "@/lib/editor/reconstruction";

interface Props {
  projectId: string;
  actor: NonNullable<Actor>;
  /** Slides the save viewer back in (Studio); without it the logo links to /projects. */
  onShowSaves?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called once the first take and its meshes are shown (or opening failed). */
  onReady?: () => void;
}

interface Loaded {
  project: Project;
  takes: TakeSummary[];
  revision: Revision;
}

type Notice = { tone: "ok" | "bad" | "info"; text: string; conflict?: boolean } | null;

const TOOLS: { id: Tool; label: string; key: string; hint: string; icon: typeof CursorArrowRaysIcon }[] = [
  { id: "select", label: "Select", key: "V", hint: "click an object to select it", icon: CursorArrowRaysIcon },
  { id: "move", label: "Move", key: "W", hint: "drag the arrows to move", icon: ArrowsRightLeftIcon },
  { id: "rotate", label: "Rotate", key: "E", hint: "drag the rings to rotate", icon: ArrowPathIcon },
  { id: "scale", label: "Scale", key: "R", hint: "drag any handle; scale stays uniform", icon: ArrowsPointingOutIcon },
];

function download(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "take";
}

export function Editor({ projectId, actor, onShowSaves, onDirtyChange, onReady }: Props) {
  const api = useMemo(() => new HttpBackend(), []);
  const blobs = useMemo(() => new PlatformBlobStore({ api, actor }), [api, actor]);
  const assetDeps = useMemo(() => ({ assets: api.assets, blobs, actor }), [api, blobs, actor]);
  const ingestor = useMemo(
    () => new CaptureIngestor({ assets: api.assets, ingestion: api.ingestion, blobs, actor, projectId, encoder: canvasEncoder }),
    [api, blobs, actor, projectId],
  );

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [reconstructOpen, setReconstructOpen] = useState(false);
  const [grid, setGrid] = useState(true);
  const [splatFallbacks, setSplatFallbacks] = useState<Record<string, string | null>>({});
  const [splatsLoading, setSplatsLoading] = useState<Record<string, boolean>>({});

  const viewportEl = useRef<HTMLDivElement>(null);
  const viewport = useRef<EditorViewport | null>(null);
  const historyRef = useRef<History | null>(null);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const present = history?.present ?? null;
  const dirty = !!(present && loaded && !sameManifest(present, loaded.revision.manifest));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  const [nav, setNav] = useState<Navigation>("orbit");

  /** Explicit (re)load of a take: switch, fork, conflict reload. */
  const open = useCallback(
    async (takeId?: string) => {
      setBusy("Loading");
      const r = await loadTake(api.projects, actor, projectId, takeId);
      setBusy(null);
      if (!r.ok) return setNotice({ tone: "bad", text: `Could not open the take: ${r.error.message}` });
      setLoaded(r.value);
      setHistory(startHistory(r.value.revision.manifest));
      setSelected(null);
      setNotice(null);
    },
    [api, actor, projectId],
  );

  // First load: the project's active take.
  useEffect(() => {
    let live = true;
    void loadTake(api.projects, actor, projectId).then((r) => {
      if (!live) return;
      if (!r.ok) {
        onReadyRef.current?.();
        return setLoadError(`${r.error.code}: ${r.error.message}`);
      }
      historyRef.current = startHistory(r.value.revision.manifest);
      setLoaded(r.value);
      setHistory(historyRef.current);
    });
    return () => {
      live = false;
    };
  }, [api, actor, projectId]);

  // Viewport lifetime follows the container element.
  const apply = useCallback((edit: (h: History) => History) => {
    setHistory((h) => (h ? edit(h) : h));
  }, []);

  useEffect(() => {
    const el = viewportEl.current;
    if (!el || !loaded) return;
    const vp = new EditorViewport(el, {
      onSelect: setSelected,
      onTransformEnd: (objectId: string, t: Transform) =>
        apply((h) => commit(h, setObjectTransform(h.present, objectId, cleanTransform(t)))),
      loadAsset: async (assetId) => {
        const r = await loadProjectAsset(assetDeps, projectId, assetId);
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        return r.value.bytes;
      },
      onAssetError: (assetId, message) => setNotice({ tone: "bad", text: `Asset ${assetId} could not be shown: ${message}` }),
      onSplatLoading: (objectId, loading) => setSplatsLoading((m) => ({ ...m, [objectId]: loading })),
      onSplatFallback: (objectId, reason) => {
        setSplatFallbacks((m) => ({ ...m, [objectId]: reason }));
        setNotice({ tone: "bad", text: `Splat unavailable, showing the mesh instead: ${reason}` });
      },
    });
    viewport.current = vp;
    if (historyRef.current) void vp.sync(historyRef.current.present).then(() => onReadyRef.current?.());
    return () => {
      vp.dispose();
      viewport.current = null;
    };
    // Recreate only when the project first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!loaded, apply, assetDeps, projectId]);

  useEffect(() => {
    if (present) viewport.current?.sync(present);
  }, [present]);
  useEffect(() => viewport.current?.select(selected), [selected]);
  useEffect(() => viewport.current?.setTool(tool), [tool]);
  useEffect(() => viewport.current?.setGridVisible(grid), [grid]);
  useEffect(() => viewport.current?.setNavigation(nav), [nav]);

  const save = useCallback(async () => {
    if (!present || !loaded || !dirty) return;
    setBusy("Saving");
    const r = await saveTake(api.projects, actor, present, loaded.revision.number);
    if (!r.ok) {
      setBusy(null);
      if (r.error.code === "REVISION_CONFLICT")
        setNotice({
          tone: "bad",
          conflict: true,
          text: "This take was saved elsewhere since you opened it. Nothing was overwritten. Your edits are still here; Reload discards them and opens the latest revision.",
        });
      else setNotice({ tone: "bad", text: `Save failed: ${r.error.code} ${r.error.message}` });
      return;
    }
    const reloaded = await loadTake(api.projects, actor, projectId, present.take.id);
    setBusy(null);
    if (reloaded.ok) {
      setLoaded(reloaded.value);
      // Keep undo history; the saved manifest is now the baseline for "unsaved".
    }
    setNotice({ tone: "ok", text: `Saved revision ${r.value.revision}.` });
  }, [api, actor, projectId, present, loaded, dirty]);

  const fork = useCallback(async () => {
    if (!loaded) return;
    if (dirty) {
      setNotice({ tone: "info", text: "Save or undo your changes first: a fork copies the saved revision." });
      return;
    }
    const name = nextTakeName(loaded.takes);
    setBusy("Forking");
    const r = await forkTake(api.projects, actor, { projectId, takeId: loaded.revision.takeId, revision: loaded.revision.number }, name);
    setBusy(null);
    if (!r.ok) return setNotice({ tone: "bad", text: `Fork failed: ${r.error.message}` });
    await open(r.value.takeId);
    setNotice({ tone: "ok", text: `Forked "${name}" from ${loaded.revision.manifest.take.name} r${loaded.revision.number}. The original is unchanged.` });
  }, [api, actor, projectId, loaded, dirty, open]);

  const switchTake = useCallback(
    async (takeId: string) => {
      if (dirty && !window.confirm("Discard unsaved changes to this take?")) return;
      await open(takeId);
    },
    [dirty, open],
  );

  const attachSplatFile = useCallback(
    async (objectId: string, file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = checkSplatPly(bytes);
      if (!check.ok) return setNotice({ tone: "bad", text: `${file.name} is not a usable splat (${check.reason}); the mesh stays.` });
      setBusy("Uploading splat");
      const asset = await storeProjectAsset(assetDeps, projectId, bytes, { kind: "splat", mimeType: "application/octet-stream", origin: "upload" });
      setBusy(null);
      if (!asset.ok) return setNotice({ tone: "bad", text: `Splat upload failed: ${asset.error.code} ${asset.error.message}` });
      setSplatFallbacks((m) => ({ ...m, [objectId]: null }));
      apply((h) => commit(h, attachSplat(h.present, objectId, asset.value.id)));
      setNotice({ tone: "ok", text: `Attached ${file.name} (${check.info.vertexCount.toLocaleString()} splats). Save to keep it.` });
    },
    [assetDeps, projectId, apply],
  );

  const importGlb = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspection = inspectGlb(bytes);
      if (!inspection.ok) return setNotice({ tone: "bad", text: `Not a usable GLB: ${inspection.error.message}` });
      const bounds = inspection.value.bounds;
      if (!bounds || inspection.value.triangleCount === 0) return setNotice({ tone: "bad", text: "The GLB has no triangle mesh to edit." });
      setBusy("Uploading mesh");
      const asset = await storeProjectAsset(assetDeps, projectId, bytes, { kind: "mesh", mimeType: "model/gltf-binary", origin: "upload" });
      setBusy(null);
      if (!asset.ok) return setNotice({ tone: "bad", text: `Upload failed: ${asset.error.code} ${asset.error.message}` });
      const object: SceneObject = {
        id: newId("object"),
        name: file.name.replace(/\.glb$/i, "").slice(0, 80) || "Imported mesh",
        geometry: {
          assetId: asset.value.id,
          geometryRevision: 1,
          originalAssetId: null,
          normalization: { sourceUnits: "m", sourceUpAxis: "+Y", scaleApplied: 1, nodeTransformsBaked: false },
          localBounds: { min: bounds.min, max: bounds.max },
        },
        material: { mode: "embedded" },
        transform: { position: [0, -bounds.min[1], 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        visible: true,
        dimensionsStatus: "estimated",
        provenance: { kind: "import", sourceIds: [], observationIds: [], jobId: null, provider: null, note: `Imported ${file.name.slice(0, 200)}` },
        splat: null,
        collider: null,
        physics: null,
      };
      apply((h) => commit(h, addObject(h.present, object)));
      setSelected(object.id);
      setNotice({
        tone: "ok",
        text: `Imported ${object.name} (${inspection.value.triangleCount.toLocaleString()} triangles). glTF is read as meters, +Y up; dimensions stay estimated until you confirm them. Save to keep it.`,
      });
    },
    [assetDeps, projectId, apply],
  );

  const exportPng = useCallback(async () => {
    if (!viewport.current || !present) return;
    viewport.current.select(null);
    try {
      download(await viewport.current.toPng(), `${slug(present.take.name)}.png`);
    } catch (e) {
      setNotice({ tone: "bad", text: `PNG export failed: ${(e as Error).message}` });
    }
    viewport.current.select(selected);
  }, [present, selected]);

  const exportGlb = useCallback(async () => {
    if (!viewport.current || !present) return;
    try {
      const bytes = await viewport.current.toGlb();
      download(new Blob([bytes.slice().buffer], { type: "model/gltf-binary" }), `${slug(present.take.name)}.glb`);
    } catch (e) {
      setNotice({ tone: "bad", text: `GLB export failed: ${(e as Error).message}` });
    }
  }, [present]);

  // Keyboard: tools, frame, undo/redo, delete, save; never while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        apply(e.shiftKey ? redo : undo);
      } else if (mod && k === "y") {
        e.preventDefault();
        apply(redo);
      } else if (mod && k === "s") {
        e.preventDefault();
        void save();
      } else if (mod && k === "d" && selected) {
        e.preventDefault();
        const id = newId("object");
        apply((h) => commit(h, duplicateObject(h.present, selected, id)));
        setSelected(id);
      } else if (!mod && !e.altKey) {
        const found = TOOLS.find((x) => x.key.toLowerCase() === k);
        if (found) setTool(found.id);
        else if (k === "f") viewport.current?.frame();
        else if (k === "h") setNav((n) => (n === "pan" ? "orbit" : "pan"));
        else if ((k === "delete" || k === "backspace") && selected) {
          apply((h) => commit(h, removeObject(h.present, selected)));
          setSelected(null);
        } else if (k === "escape") setSelected(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, save, selected]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loadError)
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-semibold">This project could not be opened</h1>
        <p className="mt-2 text-bad">{loadError}</p>
        <Link href="/projects" className="mt-4 inline-block underline hover:text-accent">
          Back to projects
        </Link>
      </main>
    );
  if (!loaded || !present || !history) return <LoadingScreen stage />;

  const take = present.take;
  const selectedObject = findObject(present, selected);
  const activeCamera = present.scene.cameras.find((c) => c.id === take.activeCameraId) ?? null;
  const parentName = take.parent ? (loaded.takes.find((t) => t.takeId === take.parent!.takeId)?.name ?? "another take") : null;
  const chrome = "rounded-xl border border-line bg-panel shadow-sm";
  const icon =
    "grid size-8 place-items-center rounded-lg text-ink hover:bg-panel-2 hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink";
  const labelled =
    "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink hover:bg-panel-2 hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink";
  const toolButton = (on: boolean) =>
    `grid size-8 place-items-center rounded-lg disabled:opacity-35 ${on ? "bg-accent/15 text-accent" : "text-ink hover:bg-panel-2 hover:text-accent"}`;
  const sep = <span className="mx-1 h-5 w-px bg-line" aria-hidden />;

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-stage text-ink">
      {/* Viewport fills the screen; chrome floats over it. */}
      <div ref={viewportEl} className="absolute inset-0" />
      <LoadingOverlay
        show={busy === "Loading" || busy === "Forking" || busy === "Uploading mesh" || busy === "Uploading splat" || Object.values(splatsLoading).some(Boolean)}
      />
      {present.scene.objects.length === 0 && (
        <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-muted">
          This take has no objects yet. Import a GLB, or capture a photo for reference.
        </p>
      )}

      {/* Project chip: saves, project, take, saved state */}
      <div className={`absolute top-3 left-3 flex h-11 max-w-[min(560px,calc(100vw-42rem))] items-center gap-1 px-1.5 ${chrome}`}>
        {onShowSaves ? (
          <button className={icon} onClick={onShowSaves} title="Saves" aria-label="Back to saves">
            <FolderOpenIcon className="size-5" />
          </button>
        ) : (
          <Link className={icon} href="/projects" title="Saves" aria-label="Back to saves">
            <FolderOpenIcon className="size-5" />
          </Link>
        )}
        <span className="truncate px-1 font-serif font-semibold" title={loaded.project.title}>
          {loaded.project.title}
        </span>
        {sep}
        <select
          className="h-8 min-w-0 rounded-lg bg-transparent px-1.5 text-sm hover:bg-panel-2"
          value={take.id}
          onChange={(e) => void switchTake(e.target.value)}
          disabled={!!busy}
          aria-label="Take"
          title={parentName ? `Forked from ${parentName}` : "Original take"}
        >
          {loaded.takes.map((t) => (
            <option key={t.takeId} value={t.takeId}>
              {t.name}
              {t.parent ? "" : " (original)"} · r{t.headRevision}
            </option>
          ))}
        </select>
        <span className={`flex shrink-0 items-center gap-1 px-1.5 text-xs ${dirty ? "text-bad" : "text-ok"}`} aria-live="polite">
          {busy ? (
            <Spinner className="size-4 border-2" />
          ) : dirty ? (
            <>
              <span className="size-2 rounded-full bg-bad" aria-hidden />
              Unsaved
            </>
          ) : (
            <>
              <CheckCircleIcon className="size-4" />
              Saved r{loaded.revision.number}
            </>
          )}
        </span>
      </div>

      {/* Actions (the account button sits to their right on every screen) */}
      <div className={`absolute top-3 right-15 flex h-11 items-center gap-0.5 px-1.5 ${chrome}`}>
        <button className={icon} onClick={() => apply(undo)} disabled={!history.past.length} title="Undo (Ctrl+Z)" aria-label="Undo">
          <ArrowUturnLeftIcon className="size-5" />
        </button>
        <button className={icon} onClick={() => apply(redo)} disabled={!history.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <ArrowUturnRightIcon className="size-5" />
        </button>
        {sep}
        <button className={labelled} onClick={() => void save()} disabled={!dirty || !!busy} title="Save a new revision (Ctrl+S)">
          <CloudArrowUpIcon className="size-5" />
          Save
        </button>
        <button className={labelled} onClick={() => void fork()} disabled={!!busy} title="Fork: copy the saved revision into a new take">
          <Square2StackIcon className="size-5" />
          Fork
        </button>
        {sep}
        <label className={`${icon} cursor-pointer`} title="Import GLB mesh" aria-label="Import GLB mesh">
          <ArrowUpTrayIcon className="size-5" />
          <input
            type="file"
            accept=".glb,model/gltf-binary"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importGlb(f);
            }}
          />
        </label>
        <button
          className={toolButton(captureOpen)}
          onClick={() => { setCaptureOpen((v) => !v); setReconstructOpen(false); }}
          aria-pressed={captureOpen}
          title="Capture (upload, camera, video)"
          aria-label="Capture"
        >
          <CameraIcon className="size-5" />
        </button>
        <button className={labelled} onClick={() => { setReconstructOpen(v => !v); setCaptureOpen(false); }} aria-pressed={reconstructOpen}>
          <SparklesIcon className="size-5" />Generate
        </button>
        {sep}
        <button className={labelled} onClick={() => void exportPng()} title="Download the current view as PNG">
          <PhotoIcon className="size-5" />
          PNG
        </button>
        <button className={labelled} onClick={() => void exportGlb()} title="Download the visible objects as GLB">
          <CubeIcon className="size-5" />
          GLB
        </button>
      </div>

      {captureOpen && (
        <aside className={`absolute top-17 bottom-20 left-3 z-10 w-[26rem] max-w-[calc(100%-1.5rem)] overflow-auto p-3 ${chrome}`}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-serif font-semibold">Capture</h2>
            <button className={icon} onClick={() => setCaptureOpen(false)} aria-label="Close capture">
              <XMarkIcon className="size-5" />
            </button>
          </div>
          <p className="mb-2 text-xs text-muted">
            Photos, camera frames and video frames are saved privately to this project. Open Generate to turn up to three captured objects into meshes.
          </p>
          <CapturePanel ingestor={ingestor} />
        </aside>
      )}

      {reconstructOpen && <aside className={`absolute top-17 bottom-20 left-3 z-10 w-[26rem] max-w-[calc(100%-1.5rem)] overflow-auto p-3 ${chrome}`}>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-serif font-semibold">Generate</h2><button className={icon} onClick={() => setReconstructOpen(false)} aria-label="Close generate"><XMarkIcon className="size-5" /></button></div>
        <ReconstructPanel api={api} actor={actor} projectId={projectId} takeId={take.id} onApply={(requestedTake, name, observation, outcome, placement) => {
          const current = historyRef.current;
          if (!current) return false;
          const r = reconstructedObject(current.present, requestedTake, name, observation, outcome, placement);
          if (!r.ok) { setNotice({ tone: "bad", text: r.error.message }); return false; }
          apply(h => commit(h, addObject(h.present, r.value))); setSelected(r.value.id);
          setNotice({ tone: "ok", text: "Estimated mesh added. Save to keep it; dimensions are not calibrated." });
          return true;
        }} />
      </aside>}

      {/* Inspector */}
      <div className="absolute top-17 right-3 bottom-20 w-72">
        <Inspector
          manifest={present}
          selected={selectedObject}
          onSelect={setSelected}
          onTransform={(id, t) => apply((h) => commit(h, setObjectTransform(h.present, id, cleanTransform(t))))}
          onRename={(id, name) => apply((h) => commit(h, renameObject(h.present, id, name)))}
          onVisible={(id, v) => apply((h) => commit(h, setObjectVisible(h.present, id, v)))}
          onSplatLayer={(id, on) => apply((h) => commit(h, setSplatEnabled(h.present, id, on)))}
          onAttachSplat={(id, file) => void attachSplatFile(id, file)}
          splatFallback={selectedObject ? (splatFallbacks[selectedObject.id] ?? null) : null}
        />
      </div>

      {/* Context-aware toolbar: tools and view always; object actions with a selection */}
      <div className={`absolute bottom-3 left-1/2 flex h-12 -translate-x-1/2 items-center gap-0.5 px-1.5 ${chrome}`} role="toolbar" aria-label="Tools and view">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const needsSelection = t.id !== "select" && !selectedObject;
          return (
            <button
              key={t.id}
              className={toolButton(tool === t.id)}
              onClick={() => setTool(t.id)}
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key}): ${needsSelection ? "select an object first" : t.hint}`}
              aria-label={t.label}
            >
              <Icon className="size-5" />
            </button>
          );
        })}
        {selectedObject && (
          <>
            {sep}
            <span className="max-w-40 truncate px-1.5 text-sm font-medium" title={selectedObject.name}>
              {selectedObject.name}
            </span>
            <button
              className={icon}
              onClick={() => apply((h) => commit(h, setObjectVisible(h.present, selectedObject.id, !selectedObject.visible)))}
              title={selectedObject.visible ? "Hide" : "Show"}
              aria-label={selectedObject.visible ? "Hide object" : "Show object"}
            >
              {selectedObject.visible ? <EyeIcon className="size-5" /> : <EyeSlashIcon className="size-5" />}
            </button>
            <button
              className={icon}
              onClick={() => {
                const copy = newId("object");
                apply((h) => commit(h, duplicateObject(h.present, selectedObject.id, copy)));
                setSelected(copy);
              }}
              title="Duplicate (Ctrl+D)"
              aria-label="Duplicate object"
            >
              <DocumentDuplicateIcon className="size-5" />
            </button>
            <button
              className={`${icon} hover:text-bad`}
              onClick={() => {
                apply((h) => commit(h, removeObject(h.present, selectedObject.id)));
                setSelected(null);
              }}
              title="Delete (Del)"
              aria-label="Delete object"
            >
              <TrashIcon className="size-5" />
            </button>
          </>
        )}
        {/* View controls: static, always on the right */}
        <span className="mx-1.5 h-7 w-px bg-line" aria-hidden />
        <button
          className={toolButton(nav === "pan")}
          onClick={() => setNav((n) => (n === "pan" ? "orbit" : "pan"))}
          aria-pressed={nav === "pan"}
          title={nav === "pan" ? "Pan (H): left-drag pans; click to orbit again" : "Pan (H): left-drag pans instead of orbiting"}
          aria-label="Pan"
        >
          <HandRaisedIcon className="size-5" />
        </button>
        <button className={icon} onClick={() => viewport.current?.frame()} title="Frame selection (F)" aria-label="Frame selection">
          <ViewfinderCircleIcon className="size-5" />
        </button>
        <button
          className={icon}
          onClick={() => activeCamera && viewport.current?.viewThrough(activeCamera)}
          disabled={!activeCamera}
          title={activeCamera ? `View through ${activeCamera.name}` : "This take has no camera"}
          aria-label="View through take camera"
        >
          <VideoCameraIcon className="size-5" />
        </button>
        <button className={toolButton(grid)} onClick={() => setGrid((g) => !g)} aria-pressed={grid} title="Grid" aria-label="Grid">
          <Squares2X2Icon className="size-5" />
        </button>
      </div>

      {notice && (
        <div
          role={notice.tone === "bad" ? "alert" : "status"}
          className={`absolute bottom-18 left-1/2 z-40 flex max-w-2xl -translate-x-1/2 items-start gap-3 rounded-xl border bg-panel px-3 py-2 text-sm shadow ${
            notice.tone === "bad" ? "border-bad text-bad" : notice.tone === "ok" ? "border-ok text-ok" : "border-line text-ink"
          }`}
        >
          <span>{notice.text}</span>
          {notice.conflict && (
            <button className="rounded-lg border border-line px-2 py-0.5 text-ink hover:text-accent" onClick={() => void open(take.id)}>
              Reload
            </button>
          )}
          <button className="text-muted hover:text-accent" onClick={() => setNotice(null)} aria-label="Dismiss">
            <XMarkIcon className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
