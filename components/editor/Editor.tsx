"use client";

/**
 * The persistent editor shell (PLAN §1 desktop contract, HK-004/HK-005):
 * top bar (project, take, saved state, actions), left tools, central viewport,
 * right inspector, bottom take bar, and a capture drawer. Data goes through the
 * platform client (HttpBackend + PlatformBlobStore) with the session cookie.
 */
import {
  ArrowDownOnSquareIcon,
  ClockIcon,
  ArrowPathIcon,
  ArrowDownTrayIcon,
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
  KeyIcon,
  MagnifyingGlassIcon,
  PhotoIcon,
  PlayPauseIcon,
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
import { Presence } from "@/components/ui/Presence";
import { Toast } from "@/components/ui/Toast";
import { ProjectTitle } from "./ProjectTitle";
import { CapturePanel } from "@/components/capture/CapturePanel";
import { Inspector } from "./Inspector";
import { ALL_LAYERS, checkSplatPly, drawsSplat, type LayerView } from "@/lib/scene/splat";
import { LayersMenu } from "./LayersMenu";
import { ReconstructPanel } from "./ReconstructPanel";
import { reconstructedObject } from "@/lib/editor/reconstruction";
import { defaultDurationFrames, evaluateAt, formatTakeTime, framesPerSecond, keyFrames, keyTrackOf, removeKey, setDuration, setKey, sourceAt } from "@/lib/editor/timeline";
import { SourcePane } from "./SourcePane";
import { Timeline } from "./Timeline";
import { ExportDialog, type ExportFormat } from "./ExportDialog";
import { exportProject } from "@/lib/editor/project-archive";
import type { Observation, Result, TakeManifest } from "@/lib/contracts";
import { activeCamera as renderCamera, cameraFov, cameraFromView, cameraInterpolation, cameraTrack, chooseCamera, editCamera, moveCameraKey, removeCameraKey, captureTiming, resizeTake, seedCamera, setCameraKey } from "@/lib/editor/camera";
import { CameraPane, type CaptureChoice } from "./CameraPane";
import { supportedVideoFormat, videoSize, type VideoFormat, type VideoProgress } from "@/lib/export/video";

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

type Pane = "objects" | "camera" | "generate" | "source";
/** The mode rail: each mode sets the right-hand details and the bottom actions. */
const MODES: { id: Pane; label: string; Icon: typeof CubeIcon }[] = [
  { id: "objects", label: "Objects", Icon: CubeIcon },
  { id: "camera", label: "Camera", Icon: VideoCameraIcon },
  { id: "generate", label: "Generate", Icon: SparklesIcon },
  { id: "source", label: "Source", Icon: PhotoIcon },
];

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
  const [pane, setPane] = useState<Pane>("objects");
  const [playbackOpen, setPlaybackOpen] = useState(false);
  // Frames captured in this session: the Generate frame list follows new captures.
  const [captureCount, setCaptureCount] = useState(0);
  const [cameraView, setCameraView] = useState(false);
  const [captures, setCaptures] = useState<CaptureChoice[] | null>(null);
  const [captureId, setCaptureId] = useState("");
  const findRef = useRef<{ findAll(): void }>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exporting = useRef(false);
  const videoAbort = useRef<AbortController | null>(null);
  const [videoFormat, setVideoFormat] = useState<VideoFormat | null>(null);
  const [videoProgress, setVideoProgress] = useState<VideoProgress | null>(null);
  const playheadRef = useRef(0);
  const editTransformRef = useRef<(objectId: string, t: Transform) => void>(() => {});
  const [grid, setGrid] = useState(true);
  // Mesh/Splat layer toggles: view state only, never saved (ADR-005).
  const [layers, setLayers] = useState<LayerView>(ALL_LAYERS);
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
      onTransformEnd: (objectId: string, t: Transform) => editTransformRef.current(objectId, t),
      loadAsset: async (assetId) => {
        const r = await loadProjectAsset(assetDeps, projectId, assetId);
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
        return r.value.bytes;
      },
      onAssetError: (assetId, message) => setNotice({ tone: "bad", text: `Asset ${assetId} could not be shown: ${message}` }),
      onSplatLoading: (objectId, loading) => setSplatsLoading((m) => ({ ...m, [objectId]: loading })),
      onSplatFallback: (objectId, reason) => {
        setSplatFallbacks((m) => ({ ...m, [objectId]: reason }));
        setNotice({ tone: "bad", text: `Splat unavailable: ${reason}` });
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

  // What the viewport (and PNG export) shows: the take evaluated at the playhead.
  const duration = present?.take.durationFrames ?? 0;
  const frame = duration > 0 ? Math.min(playhead, duration - 1) : 0;
  const evaluated = useMemo(() => (present ? evaluateAt(present, frame) : null), [present, frame]);
  useEffect(() => {
    playheadRef.current = frame;
  }, [frame]);
  useEffect(() => {
    if (evaluated) {
      void viewport.current?.sync(evaluated);
      viewport.current?.followCamera(cameraView ? renderCamera(evaluated) : null);
    }
  }, [evaluated, cameraView]);
  useEffect(() => {
    if (present) viewport.current?.showCameraPath(present, pane === "camera");
  }, [present, pane]);

  useEffect(() => {
    if (pane !== "camera" || captures !== null) return;
    let live = true;
    void (async () => {
      const frames = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${encodeURIComponent(projectId)}`);
      if (!frames.ok) throw new Error(frames.error.message);
      const ids = [...new Set(frames.value.map(o => o.sourceId))];
      const sources = await Promise.all(ids.map(id => api.ingestion.getSource(actor, projectId, id)));
      const choices: CaptureChoice[] = [];
      for (const source of sources) {
        if (!source.ok) throw new Error(source.error.message);
        choices.push({ source: source.value, observations: frames.value.filter(o => o.sourceId === source.value.id) });
      }
      if (live) setCaptures(choices);
    })().catch(error => {
      if (live) { setCaptures([]); setNotice({ tone: "bad", text: `Could not read capture timing: ${error instanceof Error ? error.message : String(error)}` }); }
    });
    return () => { live = false; };
  }, [pane, captures, api, actor, projectId]);

  useEffect(() => {
    if (!exportOpen || !viewport.current || !present?.take.durationFrames) return;
    let live = true;
    const canvas = viewport.current.renderer.domElement;
    void supportedVideoFormat(videoSize(canvas.width, canvas.height), present.take.frameRate).then(format => { if (live) setVideoFormat(format); }).catch(() => { if (live) setVideoFormat(null); });
    return () => { live = false; };
  }, [exportOpen, present?.take.durationFrames, present?.take.frameRate]);

  const applyCameraResult = useCallback((result: Result<TakeManifest>) => {
    if (!result.ok) return setNotice({ tone: "bad", text: result.error.message });
    setPlaying(false);
    apply(h => commit(h, result.value));
  }, [apply]);

  const poseCameraFromView = useCallback((key: boolean) => {
    const view = viewport.current?.captureView();
    if (!view) return;
    setPlaying(false);
    apply(h => commit(h, cameraFromView(h.present, view, playheadRef.current, key)));
  }, [apply]);

  /** Animated objects change only through keys: an edit sets a key at the playhead. Others edit the scene. */
  const editTransform = useCallback(
    (objectId: string, t: Transform) =>
      apply((h) =>
        commit(h, keyTrackOf(h.present, objectId) ? setKey(h.present, objectId, playheadRef.current, cleanTransform(t)) : setObjectTransform(h.present, objectId, cleanTransform(t))),
      ),
    [apply],
  );
  useEffect(() => {
    editTransformRef.current = editTransform;
  }, [editTransform]);

  /** K / key button: remove the key at the playhead, or set one from the pose on screen. */
  const toggleKey = useCallback(() => {
    if (pane === "camera") {
      const cam = evaluated ? renderCamera(evaluated) : null;
      if (!cam || !present || duration <= 0) return;
      const track = cameraTrack(present, cam.id);
      apply(h => commit(h, track?.keyframes.some(k => k.frame === frame) ? removeCameraKey(h.present, cam.id, frame) : setCameraKey(h.present, cam.id, frame, cam.transform, track?.keyframes[0].interpolation)));
      return;
    }
    if (!selected || !evaluated || duration <= 0) return;
    const pose = findObject(evaluated, selected)?.transform;
    if (!pose) return;
    apply((h) => commit(h, keyFrames(h.present, selected).includes(frame) ? removeKey(h.present, selected, frame) : setKey(h.present, selected, frame, pose)));
  }, [selected, evaluated, duration, frame, apply, pane, present]);

  // Playback: advance the playhead at the take's frame rate, looping; purely local (no provider or asset calls).
  useEffect(() => {
    if (!playing || duration <= 0 || !present) return;
    const fps = framesPerSecond(present.take.frameRate);
    const start = performance.now();
    const from = playheadRef.current;
    let raf = 0;
    const tick = (now: number) => {
      setPlayhead((from + Math.floor(((now - start) / 1000) * fps)) % duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The take's rate and length are fixed while playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);
  useEffect(() => viewport.current?.select(selected), [selected]);
  useEffect(() => viewport.current?.setTool(tool), [tool]);
  useEffect(() => viewport.current?.setGridVisible(grid), [grid]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => viewport.current?.setLayers(layers), [layers, !!loaded]);
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

  /** Replace (or add) an object's splat from a local .ply file. */
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

  const exportFile = useCallback(async (format: ExportFormat) => {
    const vp = viewport.current;
    if (!vp || !present || !evaluated || busy || exporting.current) return;
    if (format === "zip" && dirty) return;
    exporting.current = true;
    setBusy(`Exporting ${format.toUpperCase()}`);
    setExportError(null);
    setVideoProgress(null);
    const abort = new AbortController();
    videoAbort.current = format === "video" ? abort : null;
    try {
      // Let the shared overlay paint before encoding or packing the download.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (format === "zip") {
        const result = await exportProject({ ...assetDeps, projects: api.projects }, projectId);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        const name = result.value.title.replace(/[^\w\- ]+/g, "").trim() || "prometheus-project";
        download(new Blob([result.value.zip.slice().buffer], { type: "application/zip" }), `${name}.zip`);
      } else if (format === "video") {
        if (!videoFormat) throw new Error("No supported video encoder is available in this browser.");
        const blob = await vp.toVideo(present, videoFormat, abort.signal, setVideoProgress);
        download(blob, `${slug(present.take.name)}.${videoFormat.extension}`);
      } else {
        await vp.sync(evaluated);
        if (format === "png") {
          vp.select(null);
          const at = present.take.durationFrames > 0 ? `-f${frame}` : "";
          download(await vp.toPng(evaluated), `${slug(present.take.name)}${at}.png`);
        } else {
          const bytes = await vp.toGlb();
          download(new Blob([bytes.slice().buffer], { type: "model/gltf-binary" }), `${slug(present.take.name)}.glb`);
        }
      }
      setExportOpen(false);
    } catch (e) {
      setExportError(abort.signal.aborted ? "Video export canceled." : `${format.toUpperCase()} export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      try {
        if (format === "video") await vp.sync(evaluated);
        if (format === "png") vp.select(selected);
        vp.followCamera(cameraView ? renderCamera(evaluated) : null);
      } finally {
        videoAbort.current = null;
        exporting.current = false;
        setBusy(null);
      }
    }
  }, [present, evaluated, busy, dirty, assetDeps, api, projectId, frame, selected, videoFormat, cameraView]);

  // Keyboard: tools, frame, undo/redo, delete, save; never while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (exportOpen || exporting.current) return;
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
        else if (k === "f") { setCameraView(false); viewport.current?.followCamera(null); viewport.current?.frame(); }
        else if (k === "h") setNav((n) => (n === "pan" ? "orbit" : "pan"));
        else if (k === " " && duration > 0) {
          e.preventDefault();
          setPlaying((p) => !p);
        } else if (k === "home") setPlayhead(0);
        else if (k === "k" && (selected || pane === "camera")) toggleKey();
        else if ((k === "delete" || k === "backspace") && selected) {
          apply((h) => commit(h, removeObject(h.present, selected)));
          setSelected(null);
        } else if (k === "escape") setSelected(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, save, selected, duration, toggleKey, exportOpen, pane]);

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
  const shownObject = evaluated ? findObject(evaluated, selected) : selectedObject;
  const activeCamera = renderCamera(evaluated ?? present);
  const cameraKeys = activeCamera ? cameraTrack(present, activeCamera.id)?.keyframes.map(k => k.frame) ?? [] : [];
  const parentName = take.parent ? (loaded.takes.find((t) => t.takeId === take.parent!.takeId)?.name ?? "another take") : null;
  const chrome = "rounded-xl border border-line bg-panel shadow-sm";
  const shownObjects = present.scene.objects.filter((o) => o.visible);
  const nothingDrawn = shownObjects.length > 0 && !layers.mesh && !shownObjects.some((o) => drawsSplat(o, layers));
  // Capture the toolbar's camera actions follow (chosen in the Camera pane).
  const captureChoice = captures?.find((c) => c.source.id === captureId) ?? captures?.[0] ?? null;
  const captureTimingNow = captureChoice ? captureTiming(captureChoice.source, captureChoice.observations, present.take.frameRate) : null;
  const captureEstimates = captureChoice?.observations.filter((o) => o.mode === "evidence" && o.camera).length ?? 0;
  const hint =
    present.scene.objects.length === 0
      ? "This take has no objects yet. Import a GLB, or capture a photo for reference."
      : nothingDrawn
        ? layers.splat
          ? "No visible object has a splat. Turn on Mesh in Layers."
          : "No layers shown. Turn on Mesh or Splat in Layers."
        : null;
  const icon =
    "grid size-8.5 place-items-center rounded-lg text-ink hover:bg-panel-2 hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink";
  const labelled =
    "flex h-8.5 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink hover:bg-panel-2 hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink";
  const toolButton = (on: boolean) =>
    `grid size-8.5 place-items-center rounded-lg disabled:opacity-35 ${on ? "bg-accent/15 text-accent" : "text-ink hover:bg-panel-2 hover:text-accent"}`;
  const sep = <span className="mx-1 h-5 w-px bg-line" aria-hidden />;
  const loadingOverlay = (
    <LoadingOverlay
      show={(!!busy && busy !== "Saving") || (pane === "camera" && captures === null) || Object.values(splatsLoading).some(Boolean)}
      className={exportOpen ? "z-50" : ""}
    />
  );

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-stage text-ink">
      {/* Viewport fills the screen; chrome floats over it. */}
      <div ref={viewportEl} className="absolute inset-0" />
      {hint && (
        <div className="pointer-events-none absolute inset-x-0 top-17 z-40 flex justify-center px-3">
          <Toast key={hint} text={hint} />
        </div>
      )}

      {/* Project chip: saves, project, take, saved state */}
      <div className={`absolute top-3 left-3 flex h-11 max-w-[min(560px,calc(100vw-32rem))] items-center gap-1 overflow-hidden px-1.5 max-sm:max-w-[calc(100vw-19.5rem)] ${chrome}`}>
        {onShowSaves ? (
          <button className={icon} onClick={onShowSaves} title="Saves" aria-label="Back to saves">
            <FolderOpenIcon className="size-5" />
          </button>
        ) : (
          <Link className={icon} href="/projects" title="Saves" aria-label="Back to saves">
            <FolderOpenIcon className="size-5" />
          </Link>
        )}
        <ProjectTitle
          key={loaded.project.id}
          title={loaded.project.title}
          onRename={async (title) => {
            const r = await api.projects.renameProject(actor, loaded.project.id, title);
            if (!r.ok) {
              setNotice({ tone: "bad", text: `Rename failed: ${r.error.message}` });
              return false;
            }
            setLoaded((l) => (l ? { ...l, project: r.value } : l));
            return true;
          }}
        />
        {sep}
        <select
          className="h-8.5 min-w-0 rounded-lg bg-transparent px-1.5 text-sm hover:bg-panel-2"
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
          <span className="max-sm:sr-only">Save</span>
        </button>
        <button className={labelled} onClick={() => void fork()} disabled={!!busy} title="Fork: copy the saved revision into a new take">
          <Square2StackIcon className="size-5" />
          <span className="max-sm:sr-only">Fork</span>
        </button>
        {sep}
        <button className={labelled} disabled={!!busy || Object.values(splatsLoading).some(Boolean)} onClick={() => {
          setPlaying(false);
          setExportError(null);
          setExportOpen(true);
        }} aria-haspopup="dialog" title="Export image, 3D scene or project">
          <ArrowDownTrayIcon className="size-5" />
          <span className="max-sm:sr-only">Export</span>
        </button>
      </div>

      {/* Mode rail: picks what the right pane and the bottom actions are about */}
      <div className={`absolute top-17 left-3 flex flex-col gap-0.5 p-1 ${chrome}`} role="tablist" aria-orientation="vertical" aria-label="Mode">
        {MODES.map(({ id, label, Icon }) => (
          <button
            key={id}
            id={`mode-${id}`}
            role="tab"
            aria-selected={pane === id}
            aria-controls="mode-details"
            className={toolButton(pane === id)}
            onClick={() => {
              setPane(id);
              if (id === "objects" || id === "camera") setCaptureOpen(false);
            }}
            title={label}
            aria-label={label}
          >
            <Icon className="size-5" />
          </button>
        ))}
      </div>

      <Presence show={captureOpen} enter="animate-slide-left" role="complementary" aria-label="Capture drawer" className={`absolute top-17 bottom-20 left-16 z-10 w-[26rem] max-w-[calc(100%-5rem)] overflow-auto p-3 max-sm:bottom-[calc(36vh+7.5rem)] ${chrome}`}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-serif font-semibold">Capture</h2>
            <button className={icon} onClick={() => setCaptureOpen(false)} aria-label="Close capture">
              <XMarkIcon className="size-5" />
            </button>
          </div>
          <CapturePanel ingestor={ingestor} onEntry={(entry) => { if (entry.ok) setCaptureCount((n) => n + 1); }} />
      </Presence>

      {/* Details for the current mode */}
      <div key={pane} id="mode-details" role="tabpanel" aria-labelledby={`mode-${pane}`} className="absolute top-17 right-3 bottom-20 w-80 animate-fade max-sm:top-auto max-sm:bottom-28 max-sm:left-3 max-sm:h-[36vh] max-sm:w-auto">
        {pane === "camera" && (
          <div className={`h-full overflow-auto ${chrome}`}>
            <CameraPane manifest={present} camera={activeCamera} frame={frame} captures={captures ?? []}
              onChoose={id => apply(h => commit(h, chooseCamera(h.present, id)))}
              onPose={pose => activeCamera && apply(h => commit(h, editCamera(h.present, activeCamera.id, frame, cleanTransform(pose))))}
              onFov={degrees => activeCamera && apply(h => commit(h, cameraFov(h.present, activeCamera.id, degrees)))}
              onDuration={frames => applyCameraResult(resizeTake(present, frames))}
              onSeek={next => { setPlaying(false); setPlayhead(next); }}
              onRemove={key => activeCamera && apply(h => commit(h, removeCameraKey(h.present, activeCamera.id, key)))}
              onMove={(from, to) => activeCamera && applyCameraResult(moveCameraKey(present, activeCamera.id, from, to))}
              onInterpolation={mode => activeCamera && apply(h => commit(h, cameraInterpolation(h.present, activeCamera.id, mode)))}
              captureId={captureId} onCaptureId={setCaptureId}
            />
          </div>
        )}
        {pane === "objects" && (
          <Inspector
            manifest={evaluated ?? present}
            selected={shownObject}
            onSelect={setSelected}
            onTransform={editTransform}
            scope={selected && keyTrackOf(present, selected) ? "keyframe" : "scene"}
            onRename={(id, name) => apply((h) => commit(h, renameObject(h.present, id, name)))}
            onVisible={(id, v) => apply((h) => commit(h, setObjectVisible(h.present, id, v)))}
            onSplatLayer={(id, on) => apply((h) => commit(h, setSplatEnabled(h.present, id, on)))}
            onAttachSplat={(id, file) => void attachSplatFile(id, file)}
            splatFallback={selectedObject ? (splatFallbacks[selectedObject.id] ?? null) : null}
          />
        )}
        {pane === "generate" && (
          <div className={`h-full overflow-auto p-3 ${chrome}`}>
            <ReconstructPanel findRef={findRef} api={api} actor={actor} projectId={projectId} takeId={take.id} captureCount={captureCount} takeJobIds={present.scene.objects.flatMap((o) => (o.provenance.jobId ? [o.provenance.jobId] : []))} onApply={(requestedTake, name, observation, outcome, placement) => {
              const current = historyRef.current;
              if (!current) return false;
              const r = reconstructedObject(current.present, requestedTake, name, observation, outcome, placement);
              if (!r.ok) { setNotice({ tone: "bad", text: r.error.message }); return false; }
              apply(h => commit(h, addObject(h.present, r.value))); setSelected(r.value.id);
              setNotice({ tone: "ok", text: "Estimated mesh added. Save to keep it; dimensions are not calibrated." });
              return true;
            }} />
          </div>
        )}
        {pane === "source" && (
          <div className={`h-full overflow-auto p-3 ${chrome}`}>
            <SourcePane api={api} actor={actor} projectId={projectId} manifest={present} selected={shownObject} />
          </div>
        )}
      </div>

      {/* Playback pop-up: play, seek and keys (opened from the bottom toolbar) */}
      <Presence show={playbackOpen} id="playback" className="absolute bottom-17 left-1/2 w-[min(46rem,calc(100vw-1.5rem))] -translate-x-1/2 max-sm:bottom-28">
          <Timeline
            rate={present.take.frameRate}
            durationFrames={duration}
            playhead={frame}
            playing={playing}
            sourceUs={sourceAt(present, frame)?.us ?? null}
            keys={pane === "camera" ? cameraKeys : selected ? keyFrames(present, selected) : []}
            canKey={duration > 0 && (pane === "camera" ? !!activeCamera : !!selectedObject)}
            keyTarget={pane === "camera" ? "camera" : "object"}
            onPlay={setPlaying}
            onSeek={(f) => { setPlaying(false); setPlayhead(f); }}
            onAnimate={() => apply((h) => commit(h, setDuration(h.present, defaultDurationFrames(h.present.take.frameRate))))}
            onToggleKey={toggleKey}
          />
      </Presence>

      {/* Bottom toolbar: actions for the current mode, then playback, then view controls (always there) */}
      <div className={`absolute bottom-3 left-1/2 flex h-12 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-0.5 px-1.5 max-sm:h-auto max-sm:w-[calc(100vw-1.5rem)] max-sm:flex-wrap max-sm:justify-center max-sm:py-1 ${chrome}`} role="toolbar" aria-label="Actions and view">
        {pane === "objects" && (
          <>
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
          </>
        )}
        {pane === "camera" && (
          <>
            <button className={labelled} disabled={cameraView} onClick={() => poseCameraFromView(false)} title={cameraView ? "Switch to free view first" : "Move the render camera to the current free view"}>
              <ArrowDownOnSquareIcon className="size-5" />
              Align to view
            </button>
            <button className={labelled} disabled={cameraView} onClick={() => poseCameraFromView(true)} title={cameraView ? "Switch to free view first" : "Set a camera key at the playhead from the current free view"}>
              <KeyIcon className="size-5" />
              Key from view
            </button>
            <button className={labelled} disabled={!captureTimingNow} onClick={() => captureTimingNow && applyCameraResult(resizeTake(present, captureTimingNow.frames))} title={captureTimingNow ? "Make the take as long as the chosen capture" : "The chosen capture has no usable length"}>
              <ClockIcon className="size-5" />
              Capture length
            </button>
            <button className={labelled} disabled={!captureChoice || !captureEstimates} onClick={() => captureChoice && applyCameraResult(seedCamera(present, captureChoice.source, captureChoice.observations))} title={captureEstimates ? "Key the render camera from the capture's recorded camera poses" : "The chosen capture has no recorded camera poses"}>
              <VideoCameraIcon className="size-5" />
              Follow capture
            </button>
          </>
        )}
        {pane === "generate" && (
          <button className={labelled} onClick={() => findRef.current?.findAll()} title="Find the objects in the selected frame; no description needed">
            <MagnifyingGlassIcon className="size-5" />
            Find objects
          </button>
        )}
        {(pane === "generate" || pane === "source") && (
          <button
            className={`${labelled} ${captureOpen ? "bg-accent/15 text-accent" : ""}`}
            onClick={() => setCaptureOpen((v) => !v)}
            aria-pressed={captureOpen}
            title="Capture a photo, camera frame or video frame"
          >
            <CameraIcon className="size-5" />
            Capture
          </button>
        )}
        <span className="mx-1.5 h-7 w-px bg-line" aria-hidden />
        <button
          className={`${labelled} ${playbackOpen ? "bg-accent/15 text-accent" : ""}`}
          onClick={() => setPlaybackOpen((v) => !v)}
          aria-expanded={playbackOpen}
          aria-controls="playback"
          title="Playback, seek and keys"
          aria-label="Playback"
        >
          <PlayPauseIcon className="size-5" />
          <span className="font-mono text-xs tabular-nums">{duration > 0 ? formatTakeTime(frame, take.frameRate) : "Still"}</span>
        </button>
        {/* View controls: always here, in every mode */}
        <span className="mx-1.5 h-7 w-px bg-line" aria-hidden />
        <LayersMenu layers={layers} onChange={setLayers} buttonClass={toolButton} panelClass={chrome} above />
        <button
          className={toolButton(nav === "pan")}
          onClick={() => setNav((n) => (n === "pan" ? "orbit" : "pan"))}
          aria-pressed={nav === "pan"}
          title={nav === "pan" ? "Pan (H): left-drag pans; click to orbit again" : "Pan (H): left-drag pans instead of orbiting"}
          aria-label="Pan"
        >
          <HandRaisedIcon className="size-5" />
        </button>
        <button className={icon} onClick={() => { setCameraView(false); viewport.current?.followCamera(null); viewport.current?.frame(); }} title="Frame selection (F)" aria-label="Frame selection">
          <ViewfinderCircleIcon className="size-5" />
        </button>
        <button
          className={toolButton(cameraView)}
          onClick={() => setCameraView(v => !v)}
          aria-pressed={cameraView}
          disabled={!activeCamera}
          title={activeCamera ? `View through ${activeCamera.name}` : "This take has no camera"}
          aria-label={cameraView ? "Switch to free view" : "View through take camera"}
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
          className={`absolute ${playbackOpen ? "bottom-32" : "bottom-17"} left-1/2 z-40 flex max-w-2xl -translate-x-1/2 animate-pop items-start gap-3 rounded-xl border bg-panel px-3 py-2 text-sm shadow ${
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
      {!exportOpen && loadingOverlay}
      {exportOpen && (
        <ExportDialog takeName={take.name} frame={frame} animated={duration > 0} dirty={dirty} busy={!!busy} error={exportError} progress={loadingOverlay}
          cameraReady={!!activeCamera} videoLabel={duration > 0 && videoFormat ? `Video (.${videoFormat.extension})` : null}
          videoDescription={`${(duration / framesPerSecond(take.frameRate)).toFixed(2)} s at ${framesPerSecond(take.frameRate).toFixed(2)} fps, up to 1280 px, no audio.`}
          progressLabel={videoProgress ? `Rendering frame ${videoProgress.completed} of ${videoProgress.total}` : null}
          onCancelExport={busy === "Exporting VIDEO" ? () => videoAbort.current?.abort() : undefined}
          onClose={() => { if (!exporting.current) setExportOpen(false); }} onExport={(format) => void exportFile(format)} />
      )}
    </div>
  );
}
