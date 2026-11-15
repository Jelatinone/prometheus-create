/**
 * Three.js viewport for the editor (HK-004/HK-005). Browser only.
 *
 * Each SceneObject becomes a wrapper Group carrying the manifest transform; the
 * GLB scene sits inside it untouched, so GLTFLoader applies the file's own node
 * transforms and the manifest transform is applied exactly once on top.
 * Selection, orbiting and gizmo hover are view state; only a finished gizmo
 * drag reports a transform (onTransformEnd), which the editor commits as one
 * undoable edit.
 */
import {
  AmbientLight,
  Box3,
  BoxHelper,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  MOUSE,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Quat, Transform, Vec3 } from "@/lib/contracts/common";
import type { TakeManifest } from "@/lib/contracts/revision";
import type { Camera as SceneCamera, SceneObject } from "@/lib/contracts/scene";
import { checkSplatPly, wantsSplat } from "./splat";

export type Tool = "select" | "move" | "rotate" | "scale";
/** What a left-drag (one-finger drag) does: orbit around the target, or pan the view. Right-drag always pans. */
export type Navigation = "orbit" | "pan";

export interface ViewportCallbacks {
  onSelect(objectId: string | null): void;
  /** A finished gizmo drag: the new transform of the dragged object. */
  onTransformEnd(objectId: string, transform: Transform): void;
  /** Asset bytes for a geometry asset (GLB). */
  loadAsset(assetId: string): Promise<Uint8Array>;
  /** Asset failed to load or parse; the object is shown as missing. */
  onAssetError?(assetId: string, message: string): void;
  /** The object's splat could not be shown; the viewport keeps drawing its mesh. */
  onSplatFallback?(objectId: string, reason: string): void;
  /** A splat started (true) or finished/failed (false) loading; the editor dims the viewport meanwhile. */
  onSplatLoading?(objectId: string, loading: boolean): void;
}

/** loading: fetching/parsing; settling: added to Spark, waiting for its first sorted frame; ready: drawn. */
type SplatStatus = "none" | "loading" | "settling" | "ready" | "failed";

/** The Spark renderer fields used to tell when a new splat has actually been drawn. */
type SparkProgress = { sorting: boolean; lastSortTime: number; display?: { mappingVersion: number }; current?: { mappingVersion: number } };
const SETTLE_TIMEOUT_MS = 4000;

interface ObjectEntry {
  group: Group;
  /** Mesh layer (the GLB) and splat layer share the group's transform: one object, two looks. */
  meshLayer: Group;
  splatLayer: Group;
  assetId: string | null;
  splatAssetId: string | null;
  splatStatus: SplatStatus;
  wantsSplat: boolean;
  /** performance.now() when the splat was handed to Spark (settling). */
  settlingSince: number;
}

/** Spark is browser-only and large; load it the first time a splat is needed. */
let sparkModule: Promise<typeof import("@sparkjsdev/spark")> | null = null;
const loadSpark = () => (sparkModule ??= import("@sparkjsdev/spark"));

const CANVAS = new Color("#cbc8c1"); // --color-stage
const SELECT = 0xff6842;

export class EditorViewport {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera(50, 1, 0.01, 200);
  private readonly scene = new Scene();
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly helpers = new Group();
  private readonly objects = new Map<string, ObjectEntry>();
  private spark: (Object3D & SparkProgress) | null = null;
  private readonly assets = new Map<string, Promise<Object3D | null>>();
  private readonly loader = new GLTFLoader();
  private readonly resize: ResizeObserver;
  private outline: BoxHelper | null = null;
  private selected: string | null = null;
  private tool: Tool = "select";
  private dragStartScale: Vec3 | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly cb: ViewportCallbacks) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = "block h-full w-full touch-none outline-none";
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.scene.background = CANVAS;
    this.scene.add(new HemisphereLight(0xffffff, 0xb9b2a5, 1.6), new AmbientLight(0xffffff, 0.3));
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(2.5, 4, 3);
    this.scene.add(sun);
    const grid = new GridHelper(10, 40, 0x8f8a80, 0xb3afa7);
    this.helpers.add(grid);
    this.scene.add(this.helpers);

    this.camera.position.set(1.6, 1.3, 2.4);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.4, 0);
    this.orbit.enableDamping = true;
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener("mouseDown", () => {
      const obj = this.gizmo.object;
      this.dragStartScale = obj ? [obj.scale.x, obj.scale.y, obj.scale.z] : null;
    });
    this.gizmo.addEventListener("objectChange", () => this.keepUniformScale());
    this.gizmo.addEventListener("mouseUp", () => {
      const obj = this.gizmo.object;
      const id = obj?.userData.objectId as string | undefined;
      if (obj && id) this.cb.onTransformEnd(id, transformOf(obj));
    });
    this.helpers.add(this.gizmo.getHelper());

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.renderer.setAnimationLoop(() => {
      this.settleSplats();
      this.orbit.update();
      this.outline?.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Reconciles the three.js scene with the manifest (add, update, remove); resolves once new meshes are shown. */
  sync(manifest: TakeManifest): Promise<void> {
    const seen = new Set<string>();
    const loading: Promise<unknown>[] = [];
    for (const object of manifest.scene.objects) {
      seen.add(object.id);
      let entry = this.objects.get(object.id);
      if (!entry) {
        const group = new Group();
        group.name = object.name;
        group.userData.objectId = object.id;
        const meshLayer = new Group();
        meshLayer.name = "mesh";
        const splatLayer = new Group();
        splatLayer.name = "splat";
        splatLayer.visible = false;
        group.add(meshLayer, splatLayer);
        this.scene.add(group);
        entry = { group, meshLayer, splatLayer, assetId: null, splatAssetId: null, splatStatus: "none", wantsSplat: false, settlingSince: 0 };
        this.objects.set(object.id, entry);
      }
      const { group, meshLayer } = entry;
      group.name = object.name;
      group.visible = object.visible;
      applyTransform(group, object.transform);
      if (entry.assetId !== object.geometry.assetId) {
        entry.assetId = object.geometry.assetId;
        const assetId = object.geometry.assetId;
        meshLayer.clear();
        loading.push(
          this.asset(assetId).then((model) => {
            if (this.disposed || this.objects.get(object.id)?.assetId !== assetId) return;
            if (model) meshLayer.add(model.clone(true));
          }),
        );
      }
      loading.push(this.syncSplat(object, entry));
    }
    for (const [id, entry] of this.objects)
      if (!seen.has(id)) {
        this.scene.remove(entry.group);
        disposeSplats(entry.splatLayer);
        if (entry.splatStatus === "loading" || entry.splatStatus === "settling") this.cb.onSplatLoading?.(id, false);
        entry.splatAssetId = null; // a load still in flight for this entry is discarded
        this.objects.delete(id);
      }
    this.select(this.selected && seen.has(this.selected) ? this.selected : null);
    return Promise.all(loading).then(() => undefined);
  }

  select(objectId: string | null) {
    this.selected = objectId;
    if (this.outline) {
      this.helpers.remove(this.outline);
      this.outline.dispose();
      this.outline = null;
    }
    const group = objectId ? this.objects.get(objectId)?.group : undefined;
    if (group) {
      this.outline = new BoxHelper(group, SELECT);
      this.helpers.add(this.outline);
    }
    if (group && this.tool !== "select") this.gizmo.attach(group);
    else this.gizmo.detach();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    if (tool !== "select") this.gizmo.setMode(tool === "move" ? "translate" : tool);
    this.select(this.selected);
  }

  /** Orbit target and distance to the selection (or everything). */
  frame(objectId: string | null = this.selected) {
    const box = new Box3();
    const targets = objectId ? [this.objects.get(objectId)?.group] : [...this.objects.values()].map((e) => e.group);
    for (const g of targets) if (g) box.expandByObject(g);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.05);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const dist = radius / Math.sin(((this.camera.fov / 2) * Math.PI) / 180);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.15);
    this.orbit.update();
  }

  /** Puts the view at a scene camera (e.g. the take's estimated source camera). */
  viewThrough(cam: SceneCamera) {
    applyTransform(this.camera, { ...cam.transform, scale: [1, 1, 1] });
    this.camera.fov = cam.verticalFovDeg;
    this.camera.near = cam.near;
    this.camera.far = cam.far;
    this.camera.updateProjectionMatrix();
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.orbit.target.copy(this.camera.position).addScaledVector(forward, 2);
    this.orbit.update();
  }

  setNavigation(mode: Navigation) {
    this.orbit.mouseButtons.LEFT = mode === "pan" ? MOUSE.PAN : MOUSE.ROTATE;
    this.orbit.touches.ONE = mode === "pan" ? TOUCH.PAN : TOUCH.ROTATE;
  }

  setGridVisible(visible: boolean) {
    this.helpers.children[0].visible = visible;
  }

  /** PNG of the current view without grid, gizmo or selection outline. */
  async toPng(): Promise<Blob> {
    const shown = this.helpers.visible;
    this.helpers.visible = false;
    this.renderer.render(this.scene, this.camera);
    const blob = await new Promise<Blob | null>((resolve) => this.renderer.domElement.toBlob(resolve, "image/png"));
    this.helpers.visible = shown;
    if (!blob) throw new Error("the browser could not encode the viewport as PNG");
    return blob;
  }

  /** Binary glTF of the visible objects with their manifest transforms (meters, +Y up). */
  async toGlb(): Promise<Uint8Array> {
    const root = new Scene();
    root.name = "Prometheus::create take";
    for (const { group } of this.objects.values()) {
      if (!group.visible) continue;
      const copy = group.clone(false);
      const mesh = group.getObjectByName("mesh");
      if (mesh) copy.add(mesh.clone(true)); // splats are an appearance layer; GLB carries the mesh
      root.add(copy);
    }
    const out = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, trs: true });
    if (!(out instanceof ArrayBuffer)) throw new Error("GLB export did not produce binary output");
    return new Uint8Array(out);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Which layer this object should draw, loading its splat when first needed. */
  private async syncSplat(object: SceneObject, entry: ObjectEntry): Promise<void> {
    entry.wantsSplat = wantsSplat(object);
    const assetId = object.splat?.assetId ?? null;
    if (entry.wantsSplat && assetId && assetId !== entry.splatAssetId) {
      entry.splatAssetId = assetId;
      entry.splatStatus = "loading";
      disposeSplats(entry.splatLayer);
      this.applyLayers(entry);
      this.cb.onSplatLoading?.(object.id, true);
      try {
        const bytes = await this.cb.loadAsset(assetId);
        const check = checkSplatPly(bytes);
        if (!check.ok) throw new Error(check.reason);
        const { SparkRenderer, SplatMesh } = await loadSpark();
        if (this.disposed || entry.splatAssetId !== assetId) return;
        if (!this.spark) {
          this.spark = new SparkRenderer({ renderer: this.renderer }) as unknown as Object3D & SparkProgress;
          this.scene.add(this.spark);
        }
        const splats = new SplatMesh({ fileBytes: bytes.slice().buffer, fileName: `${assetId}.ply` });
        await splats.initialized;
        if (this.disposed || entry.splatAssetId !== assetId) return splats.dispose();
        entry.splatLayer.add(splats);
        // Drawn only after Spark's first sort; until then the mesh stays and the editor shows the overlay.
        entry.splatStatus = "settling";
        entry.settlingSince = performance.now();
      } catch (e) {
        if (entry.splatAssetId !== assetId) return;
        entry.splatStatus = "failed";
        this.cb.onSplatLoading?.(object.id, false);
        this.cb.onSplatFallback?.(object.id, e instanceof Error ? e.message : String(e));
      }
    } else if (!assetId && entry.splatAssetId) {
      entry.splatAssetId = null;
      entry.splatStatus = "none";
      disposeSplats(entry.splatLayer);
    }
    this.applyLayers(entry);
  }

  /** Splat only when wanted and drawn; otherwise the mesh (the fallback). While settling both are present so Spark can sort. */
  private applyLayers(entry: ObjectEntry) {
    const settling = entry.wantsSplat && entry.splatStatus === "settling";
    const splat = entry.wantsSplat && entry.splatStatus === "ready";
    entry.splatLayer.visible = splat || settling;
    entry.meshLayer.visible = !splat;
  }

  /** Each frame: a settling splat becomes ready once Spark has sorted and displayed it (or after a safety timeout). */
  private settleSplats() {
    for (const [id, entry] of this.objects) {
      if (entry.splatStatus !== "settling") continue;
      const s = this.spark;
      const sorted = !!s && !s.sorting && s.lastSortTime > entry.settlingSince && s.display?.mappingVersion === s.current?.mappingVersion;
      if (!sorted && performance.now() - entry.settlingSince < SETTLE_TIMEOUT_MS) continue;
      entry.splatStatus = "ready";
      this.applyLayers(entry);
      this.cb.onSplatLoading?.(id, false);
    }
  }

  /** What each object is currently drawing (for the inspector and tests). */
  layerOf(objectId: string): { showing: "mesh" | "splat"; splat: SplatStatus } | null {
    const entry = this.objects.get(objectId);
    if (!entry) return null;
    return { showing: entry.splatLayer.visible ? "splat" : "mesh", splat: entry.splatStatus };
  }

  private asset(assetId: string): Promise<Object3D | null> {
    let pending = this.assets.get(assetId);
    if (!pending) {
      pending = this.cb
        .loadAsset(assetId)
        .then(async (bytes) => {
          const copy = bytes.slice().buffer;
          const gltf = await this.loader.parseAsync(copy, "");
          return gltf.scene as Object3D;
        })
        .catch((e: unknown) => {
          this.assets.delete(assetId);
          this.cb.onAssetError?.(assetId, e instanceof Error ? e.message : String(e));
          return null;
        });
      this.assets.set(assetId, pending);
    }
    return pending;
  }

  /** Scale mode drags one axis; keep the object's proportions (uniform scale). */
  private keepUniformScale() {
    const obj = this.gizmo.object;
    if (!obj || this.gizmo.mode !== "scale" || !this.dragStartScale) return;
    const s = this.dragStartScale;
    const ratios = [obj.scale.x / s[0], obj.scale.y / s[1], obj.scale.z / s[2]];
    const r = ratios.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
    const k = Math.max(r, 1e-3);
    obj.scale.set(s[0] * k, s[1] * k, s[2] * k);
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return; // an orbit drag, not a click
    if (this.gizmo.dragging || this.gizmo.axis) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const groups = [...this.objects.values()].map((o) => o.group).filter((g) => g.visible);
    const hit = ray.intersectObjects(groups, true)[0];
    let node: Object3D | null = hit?.object ?? null;
    while (node && !node.userData.objectId) node = node.parent;
    const id = (node?.userData.objectId as string | undefined) ?? null;
    this.select(id);
    this.cb.onSelect(id);
  };
}

function disposeSplats(layer: Group) {
  for (const child of [...layer.children]) {
    (child as Object3D & { dispose?: () => void }).dispose?.();
    layer.remove(child);
  }
}

function applyTransform(target: Object3D, t: Transform) {
  target.position.set(...t.position);
  target.quaternion.set(...t.rotation);
  target.scale.set(...t.scale);
}

function transformOf(obj: Object3D): Transform {
  const q = obj.quaternion;
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [q.x, q.y, q.z, q.w] as Quat,
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}
