"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { inspectGlb, type GlbInspection } from "@/lib/assets/glb";
import type { ContractError } from "@/lib/contracts/common";

interface Loaded {
  name: string;
  bytes: ArrayBuffer;
  inspection: { ok: true; value: GlbInspection } | { ok: false; error: ContractError };
}

const fmt = (v: number) => v.toFixed(3);

/** Raw three.js viewer: 1 m major grid, 10 cm minor grid, axes, bounds box. */
function Viewer({ bytes }: { bytes: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setLoadError(null);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x15181e);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const major = new THREE.GridHelper(10, 10, 0x6b7280, 0x3a404a);
    const minor = new THREE.GridHelper(2, 20, 0x2b313b, 0x2b313b);
    minor.position.y = -0.001;
    scene.add(minor, major, new THREE.AxesHelper(0.5));

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(1.6, 1.4, 2.2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.4, 0);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    let disposed = false;
    new GLTFLoader().parse(
      bytes.slice(0),
      "",
      (gltf) => {
        if (disposed) return;
        scene.add(gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        scene.add(new THREE.Box3Helper(box, 0xf2a541));
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3()).length();
          controls.target.copy(center);
          camera.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 1).multiplyScalar(Math.max(size, 0.5)));
        }
      },
      (e: unknown) => !disposed && setLoadError(e instanceof Error ? e.message : String((e as { message?: string }).message ?? e)),
    );

    let frame = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((m) => m.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bytes]);

  return (
    <div className="relative h-[26rem] overflow-hidden rounded-lg border border-line" ref={host}>
      {loadError && (
        <p className="absolute inset-x-0 top-0 bg-panel/90 p-2 text-sm text-bad">
          ✗ three.js could not load this file: {loadError}
        </p>
      )}
    </div>
  );
}

export function GlbInspector({ fixtureUrl }: { fixtureUrl: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  function accept(name: string, bytes: ArrayBuffer) {
    setError(null);
    setLoaded({ name, bytes, inspection: inspectGlb(bytes) });
  }

  async function loadFixture() {
    try {
      const res = await fetch(fixtureUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      accept(fixtureUrl.split("/").pop()!, await res.arrayBuffer());
    } catch (e) {
      setError(`Could not fetch ${fixtureUrl}: ${(e as Error).message}`);
    }
  }

  const ins = loaded?.inspection.ok ? loaded.inspection.value : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={loadFixture}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-canvas hover:brightness-110"
        >
          Load axis-box fixture
        </button>
        <label className="cursor-pointer rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:border-accent">
          Open .glb…
          <input
            type="file"
            accept=".glb,model/gltf-binary"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) accept(file.name, await file.arrayBuffer());
            }}
          />
        </label>
      </div>
      {error && <p className="text-sm text-bad">✗ {error}</p>}
      {loaded && (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Viewer bytes={loaded.bytes} />
          <aside className="rounded-lg border border-line bg-panel p-4 text-sm" aria-live="polite">
            <h2 className="font-medium">{loaded.name}</h2>
            {!loaded.inspection.ok ? (
              <p className="mt-3 text-bad">
                ✗ {loaded.inspection.error.code}: {loaded.inspection.error.message}
              </p>
            ) : (
              ins && (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <dt className="text-muted">Dimensions</dt>
                  <dd className="font-mono">
                    {ins.dimensions ? ins.dimensions.map(fmt).join(" × ") : "unknown"}
                  </dd>
                  <dt className="text-muted">Bounds min</dt>
                  <dd className="font-mono text-xs">{ins.bounds ? ins.bounds.min.map(fmt).join(", ") : "–"}</dd>
                  <dt className="text-muted">Bounds max</dt>
                  <dd className="font-mono text-xs">{ins.bounds ? ins.bounds.max.map(fmt).join(", ") : "–"}</dd>
                  <dt className="text-muted">Triangles</dt>
                  <dd>{ins.triangleCount.toLocaleString()}</dd>
                  <dt className="text-muted">Meshes / nodes</dt>
                  <dd>
                    {ins.meshCount} / {ins.nodeCount}
                  </dd>
                  <dt className="text-muted">Materials / textures</dt>
                  <dd>
                    {ins.materialCount} / {ins.textureCount}
                  </dd>
                  <dt className="text-muted">Node transforms</dt>
                  <dd>{ins.hasNodeTransforms ? "yes (not baked)" : "none"}</dd>
                  <dt className="text-muted">Extensions</dt>
                  <dd className="text-xs">{ins.extensionsUsed.join(", ") || "none"}</dd>
                  <dt className="text-muted">Size</dt>
                  <dd>{(ins.byteLength / 1024).toFixed(1)} KiB</dd>
                  <dt className="text-muted">Warnings</dt>
                  <dd>
                    {ins.warnings.length === 0 ? (
                      <span className="text-ok">✓ none</span>
                    ) : (
                      <ul className="list-disc pl-4 text-accent">
                        {ins.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
              )
            )}
            <p className="mt-4 text-xs text-muted">
              Dimensions are in file units (glTF specifies meters). Grid: 1 m major, 10 cm minor. The
              orange box is the computed world bounds.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
