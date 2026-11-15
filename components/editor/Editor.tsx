"use client";

/**
 * The persistent editor shell (PLAN §1 desktop contract, HK-004/HK-005):
 * top bar (project, take, saved state, actions), left tools, central viewport,
 * right inspector, bottom take bar, and a capture drawer. Data goes through the
 * platform client (HttpBackend + PlatformBlobStore) with the session cookie.
 */
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
  setObjectVisible,
  startHistory,
  undo,
  type History,
} from "@/lib/editor/model";
import { forkTake, loadTake, nextTakeName, saveTake } from "@/lib/editor/session";
import { PlatformBlobStore } from "@/lib/platform/blob-store";
import { HttpBackend } from "@/lib/platform/http-backend";
import { EditorViewport, type Tool } from "@/lib/scene/viewport";
import { CapturePanel } from "@/components/capture/CapturePanel";
import { Inspector } from "./Inspector";

interface Props {
  projectId: string;
  actor: NonNullable<Actor>;
  userLabel: string;
}

interface Loaded {
  project: Project;
  takes: TakeSummary[];
  revision: Revision;
}

type Notice = { tone: "ok" | "bad" | "info"; text: string; conflict?: boolean } | null;

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Click an object to select it" },
  { id: "move", label: "Move", key: "W", hint: "Drag the arrows to move" },
  { id: "rotate", label: "Rotate", key: "E", hint: "Drag the rings to rotate" },
  { id: "scale", label: "Scale", key: "R", hint: "Drag any handle; scale stays uniform" },
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

export function Editor({ projectId, actor, userLabel }: Props) {
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
  const [grid, setGrid] = useState(true);

  const viewportEl = useRef<HTMLDivElement>(null);
  const viewport = useRef<EditorViewport | null>(null);
  const historyRef = useRef<History | null>(null);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const present = history?.present ?? null;
  const dirty = !!(present && loaded && !sameManifest(present, loaded.revision.manifest));

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
      if (!r.ok) return setLoadError(`${r.error.code}: ${r.error.message}`);
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
    });
    viewport.current = vp;
    if (historyRef.current) vp.sync(historyRef.current.present);
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
  if (!loaded || !present || !history) return <p className="p-6 text-muted">Opening the editor…</p>;

  const take = present.take;
  const selectedObject = findObject(present, selected);
  const activeCamera = present.scene.cameras.find((c) => c.id === take.activeCameraId) ?? null;
  const button = "rounded border border-line bg-panel px-2.5 py-1 text-sm hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink";

  return (
    <div className="fixed inset-0 z-30 grid grid-rows-[auto_1fr_auto] overflow-hidden bg-canvas text-ink">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Link href="/projects" className="font-semibold hover:text-accent" title="All projects">
          Prometheus::create
        </Link>
        <span className="text-muted">/</span>
        <span className="max-w-48 truncate font-medium" title={loaded.project.title}>
          {loaded.project.title}
        </span>
        <label className="ml-2 flex items-center gap-1 text-sm">
          <span className="text-muted">Take</span>
          <select
            className="rounded border border-line bg-canvas px-1.5 py-1"
            value={take.id}
            onChange={(e) => void switchTake(e.target.value)}
            disabled={!!busy}
          >
            {loaded.takes.map((t) => (
              <option key={t.takeId} value={t.takeId}>
                {t.name}
                {t.parent ? "" : " (original)"} · r{t.headRevision}
              </option>
            ))}
          </select>
        </label>
        <span className={`text-sm ${dirty ? "text-bad" : "text-ok"}`} aria-live="polite">
          {busy ? `${busy}…` : dirty ? "● Unsaved changes" : `✓ Saved r${loaded.revision.number}`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button className={button} onClick={() => apply(undo)} disabled={!history.past.length} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button className={button} onClick={() => apply(redo)} disabled={!history.future.length} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
          <button className={button} onClick={() => void save()} disabled={!dirty || !!busy} title="Save a new revision (Ctrl+S)">
            Save
          </button>
          <button className={button} onClick={() => void fork()} disabled={!!busy} title="Copy the saved revision into a new take">
            Fork take
          </button>
          <label className={`${button} cursor-pointer`} title="Add a GLB mesh to this take">
            Import GLB
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
          <button className={button} onClick={() => setCaptureOpen((v) => !v)} aria-pressed={captureOpen}>
            Capture
          </button>
          <button className={button} onClick={() => void exportPng()} title="Download the current view as PNG">
            Export PNG
          </button>
          <button className={button} onClick={() => void exportGlb()} title="Download the visible objects as GLB">
            Export GLB
          </button>
          <span className="ml-1 hidden text-xs text-muted lg:inline" title="Signed in">
            {userLabel}
          </span>
        </div>
      </header>

      {notice && (
        <div
          role={notice.tone === "bad" ? "alert" : "status"}
          className={`absolute bottom-12 left-1/2 z-40 flex max-w-2xl -translate-x-1/2 items-start gap-3 rounded border bg-panel px-3 py-2 text-sm shadow ${
            notice.tone === "bad" ? "border-bad text-bad" : notice.tone === "ok" ? "border-ok text-ok" : "border-line text-ink"
          }`}
        >
          <span>{notice.text}</span>
          {notice.conflict && (
            <button className={button} onClick={() => void open(take.id)}>
              Reload
            </button>
          )}
          <button className="text-muted hover:text-accent" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="grid min-h-0 grid-cols-[auto_1fr_18rem]">
        {/* Left tools */}
        <nav className="flex flex-col gap-1 border-r border-line bg-panel p-1.5" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key}): ${t.hint}`}
              className={`w-16 rounded px-1 py-1.5 text-xs ${tool === t.id ? "bg-ink text-canvas" : "hover:text-accent"}`}
            >
              {t.label}
              <span className="block text-[10px] opacity-70">{t.key}</span>
            </button>
          ))}
          <button
            className="w-16 rounded px-1 py-1.5 text-xs text-muted"
            disabled
            title="Lasso masks are not in this build (V1 uses imported or fixture meshes)"
          >
            Lasso
            <span className="block text-[10px]">later</span>
          </button>
          <hr className="my-1 border-line" />
          <button className="w-16 rounded px-1 py-1.5 text-xs hover:text-accent" onClick={() => viewport.current?.frame()} title="Frame selection (F)">
            Frame
            <span className="block text-[10px] opacity-70">F</span>
          </button>
          <button
            className="w-16 rounded px-1 py-1.5 text-xs hover:text-accent disabled:opacity-40"
            onClick={() => activeCamera && viewport.current?.viewThrough(activeCamera)}
            disabled={!activeCamera}
            title={activeCamera ? `View through ${activeCamera.name}` : "This take has no camera"}
          >
            Camera
          </button>
          <button className="w-16 rounded px-1 py-1.5 text-xs hover:text-accent" onClick={() => setGrid((g) => !g)} aria-pressed={grid}>
            Grid
          </button>
        </nav>

        {/* Viewport */}
        <section className="relative min-h-0 min-w-0">
          <div ref={viewportEl} className="absolute inset-0" />
          {present.scene.objects.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-muted">
              This take has no objects yet. Import a GLB, or capture a photo for reference.
            </p>
          )}
          {captureOpen && (
            <aside className="absolute bottom-3 left-3 top-3 z-10 w-[26rem] max-w-[calc(100%-1.5rem)] overflow-auto rounded border border-line bg-panel p-3 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-semibold">Capture</h2>
                <button className="text-muted hover:text-accent" onClick={() => setCaptureOpen(false)} aria-label="Close capture">
                  ✕
                </button>
              </div>
              <p className="mb-2 text-xs text-muted">
                Photos, camera frames and video frames are saved to this project as sources (private storage). Reconstruction from a capture is not wired
                into this build.
              </p>
              <CapturePanel ingestor={ingestor} />
            </aside>
          )}
        </section>

        {/* Right inspector */}
        <Inspector
          manifest={present}
          selected={selectedObject}
          onSelect={setSelected}
          onTransform={(id, t) => apply((h) => commit(h, setObjectTransform(h.present, id, cleanTransform(t))))}
          onRename={(id, name) => apply((h) => commit(h, renameObject(h.present, id, name)))}
          onVisible={(id, v) => apply((h) => commit(h, setObjectVisible(h.present, id, v)))}
          onDuplicate={(id) => {
            const copy = newId("object");
            apply((h) => commit(h, duplicateObject(h.present, id, copy)));
            setSelected(copy);
          }}
          onDelete={(id) => {
            apply((h) => commit(h, removeObject(h.present, id)));
            setSelected(null);
          }}
        />
      </div>

      {/* Bottom take bar */}
      <footer className="flex flex-wrap items-center gap-4 border-t border-line bg-panel px-3 py-1.5 text-xs text-muted">
        <span>
          <span className="text-ink">{take.name}</span> · revision {loaded.revision.number} ({loaded.revision.origin})
        </span>
        <span>
          {take.parent
            ? `Forked from ${loaded.takes.find((t) => t.takeId === take.parent!.takeId)?.name ?? take.parent.takeId}`
            : "Original take"}
        </span>
        <span>{present.scene.objects.length} object(s)</span>
        <span className="ml-auto" title="The take timeline (keyframes, playback) is not in this build">
          Timeline: still take (playback comes later)
        </span>
      </footer>
    </div>
  );
}
