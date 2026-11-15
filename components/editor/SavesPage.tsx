"use client";

/**
 * The save viewer (modelled on Egress's saves page): a full-page list of your
 * projects with .zip download, and the selected project's live 3D preview and
 * details. Open (or double-click) slides this page left to reveal the editor.
 * Projects are private to their owner; there is no sharing in this build.
 */
import { ArrowDownTrayIcon, ArrowUpTrayIcon, ChevronDownIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadProjectAsset } from "@/lib/capture/assets";
import { newId } from "@/lib/contracts/common";
import type { Actor } from "@/lib/contracts/ports";
import { collectAssetIds, type TakeManifest } from "@/lib/contracts/revision";
import type { Project } from "@/lib/contracts/scene";
import { createExample, EXAMPLES, type ExampleProject } from "@/lib/editor/examples";
import { exportProject, importProject, MAX_ARCHIVE_BYTES } from "@/lib/editor/project-archive";
import { loadTake, type LoadedTake } from "@/lib/editor/session";
import { PlatformBlobStore } from "@/lib/platform/blob-store";
import { retargetedFixture } from "@/lib/platform/fixture-project";
import type { HttpBackend } from "@/lib/platform/http-backend";
import { EditorViewport } from "@/lib/scene/viewport";
import { LoadingOverlay } from "@/components/ui/Loading";
import { Logo } from "@/components/ui/Logo";

interface Props {
  api: HttpBackend;
  actor: NonNullable<Actor>;
  active: boolean;
  /** A project is opening behind this page: dim it until the editor is ready. */
  opening: boolean;
  openProjectId: string | null;
  onOpen(projectId: string): void;
  /** Bumped by the studio when the page slides back in, to reload the list. */
  refreshKey: number;
}

interface Detail {
  loaded: LoadedTake;
  assetCount: number;
  assetBytes: number;
}

const size = (bytes: number | undefined) =>
  bytes === undefined ? "—" : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function downloadBlob(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

const button = "inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:border-accent hover:text-accent disabled:opacity-40";
const primary = "inline-flex items-center gap-1.5 rounded-md border border-ink bg-ink px-3 py-1.5 text-sm text-canvas hover:border-accent hover:bg-accent disabled:opacity-40";

export function SavesPage({ api, actor, active, opening, openProjectId, onOpen, refreshKey }: Props) {
  const blobs = useMemo(() => new PlatformBlobStore({ api, actor }), [api, actor]);
  const deps = useMemo(() => ({ projects: api.projects, assets: api.assets, blobs, actor }), [api, blobs, actor]);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; value: Detail | null; error?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void api.listProjects(actor).then((r) => {
      if (!live) return;
      if (r.ok) {
        setProjects(r.value);
        setListError(null);
      } else setListError(`${r.error.code}: ${r.error.message}`);
    });
    return () => {
      live = false;
    };
  }, [api, actor, active, refreshKey, reload]);

  const search = query.trim().toLocaleLowerCase();
  const sorted = (projects ?? []).filter((p) => p.title.toLocaleLowerCase().includes(search)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const current = sorted.find((p) => p.id === selected)?.id ?? sorted.find((p) => p.id === openProjectId)?.id ?? sorted[0]?.id ?? null;
  const project = sorted.find((p) => p.id === current) ?? null;

  // The selected project's active take, asset totals and preview; never opens it for editing.
  useEffect(() => {
    if (!active || !current) return;
    let live = true;
    void (async () => {
      const loaded = await loadTake(api.projects, actor, current);
      if (!live) return;
      if (!loaded.ok) return setDetail({ id: current, value: null, error: loaded.error.message });
      let assetBytes = 0;
      const ids = collectAssetIds(loaded.value.revision.manifest);
      for (const id of ids) {
        const a = await api.assets.getAsset(actor, current, id);
        if (a.ok) assetBytes += a.value.byteSize;
      }
      if (live) setDetail({ id: current, value: { loaded: loaded.value, assetCount: ids.length, assetBytes } });
    })();
    return () => {
      live = false;
    };
  }, [api, actor, active, current, project?.updatedAt]);
  const shown = detail?.id === current ? detail : null;

  const selectNew = (id: string) => {
    setQuery("");
    setSelected(id);
    setReload((n) => n + 1);
  };

  const create = async () => {
    setBusy("Creating");
    const projectId = newId("project");
    const manifest = retargetedFixture({ projectId, takeId: newId("take"), assetId: newId("asset") });
    manifest.scene.objects = [];
    const r = await api.projects.createProject(actor, { projectId, title: "Untitled scene", initialManifest: manifest, idempotencyKey: `new_${projectId}` });
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "bad", text: `Could not create a project: ${r.error.message}` });
    selectNew(projectId);
  };

  const addExample = async (example: ExampleProject) => {
    setExamplesOpen(false);
    setBusy(`Creating ${example.name}`);
    const r = await createExample(deps, example);
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "bad", text: `Could not create the example: ${r.error.message}` });
    selectNew(r.value.projectId);
  };

  const download = async (p: Project) => {
    setBusy(`Packing ${p.title}`);
    const r = await exportProject(deps, p.id);
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "bad", text: `Download failed: ${r.error.code} ${r.error.message}` });
    const name = p.title.replace(/[^\w\- ]+/g, "").trim() || "prometheus-project";
    downloadBlob(new Blob([r.value.zip.slice().buffer], { type: "application/zip" }), `${name}.zip`);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_ARCHIVE_BYTES) return setMessage({ tone: "bad", text: "That file is larger than 200 MB." });
    setBusy(`Importing ${file.name}`);
    const r = await importProject(deps, new Uint8Array(await file.arrayBuffer()));
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "bad", text: `Import failed: ${r.error.message}` });
    setMessage({ tone: "ok", text: `Imported ${file.name} as a new project.` });
    selectNew(r.value.projectId);
  };

  const take = shown?.value?.loaded;
  const manifest = take?.revision.manifest ?? null;

  return (
    <section
      className={`fixed inset-0 z-40 flex flex-col bg-panel-2 text-ink ${active ? "visible translate-x-0" : "invisible -translate-x-full"}`}
      style={{ transition: `translate .45s cubic-bezier(.4,0,.2,1), visibility 0s linear ${active ? "0s" : ".45s"}` }}
      aria-label="Saves"
      aria-hidden={!active}
      inert={!active}
    >
      <header className="grid grid-cols-[minmax(0,1fr)_clamp(170px,22vw,320px)_minmax(0,1fr)] items-center gap-4 border-b border-line bg-panel pr-17 pl-5 max-md:grid-cols-[auto_1fr] md:h-17">
        <Logo />
        <input
          className="h-8 w-full min-w-0 rounded-md border border-line bg-canvas px-2.5 text-sm outline-none focus:border-accent"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search projects"
          aria-label="Search projects"
        />
        <div className="flex flex-wrap items-center justify-end gap-2 max-md:col-span-2 max-md:justify-center">
          <button className={primary} onClick={() => void create()} disabled={!!busy}>
            <PlusIcon className="size-4" />
            New
          </button>
          <span className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setExamplesOpen(false)}>
            <button className={button} onClick={() => setExamplesOpen((v) => !v)} aria-expanded={examplesOpen} aria-haspopup="menu" disabled={!!busy}>
              <PlusIcon className="size-4" />
              Example
              <ChevronDownIcon className="size-4" />
            </button>
            {examplesOpen && (
              <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-line bg-panel p-1.5 shadow-lg">
                {EXAMPLES.map((x) => (
                  <button
                    key={x.id}
                    role="menuitem"
                    className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-panel-2"
                    onClick={() => void addExample(x)}
                  >
                    <span className="block text-sm font-medium">{x.name}</span>
                    <span className="block text-xs text-muted">{x.note}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <button className={button} onClick={() => fileInput.current?.click()} disabled={!!busy} title="Import a project .zip downloaded from here">
            <ArrowUpTrayIcon className="size-4" />
            Import (.zip)
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              void importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {message && (
        <p role={message.tone === "bad" ? "alert" : "status"} className={`border-b border-line px-5 py-1.5 text-sm ${message.tone === "bad" ? "text-bad" : "text-ok"}`}>
          {message.text}
          <button className="ml-3 inline-grid align-middle text-muted hover:text-accent" onClick={() => setMessage(null)} aria-label="Dismiss">
            <XMarkIcon className="size-4" />
          </button>
        </p>
      )}
      <LoadingOverlay show={!!busy || opening} className="z-50" />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-4 px-5 py-4 max-md:grid-cols-1 max-md:overflow-auto">
        <div className="relative overflow-auto rounded-xl border border-line bg-panel">
          <LoadingOverlay show={projects === null && !listError} />
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="sticky top-0 bg-panel text-left text-xs font-semibold text-muted">
                <th className="border-b border-line px-3 py-2.5">Name</th>
                <th className="border-b border-line px-3 py-2.5 text-right">Created</th>
                <th className="border-b border-line px-3 py-2.5 text-right">Edited</th>
                <th className="w-12 border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr
                  key={p.id}
                  className={`cursor-default border-b border-panel-2 ${p.id === current ? "bg-[#ffe1d8]" : "hover:bg-panel-2"}`}
                  onClick={() => setSelected(p.id)}
                  onDoubleClick={() => onOpen(p.id)}
                >
                  <td className="w-1/2 max-w-0 truncate px-3 py-2.5 font-medium">
                    <button className="max-w-full truncate text-left hover:underline" onClick={() => setSelected(p.id)}>
                      {p.title}
                    </button>
                    {p.id === openProjectId && <em className="ml-2 text-xs font-semibold not-italic text-accent">Open</em>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted">{when(p.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{when(p.updatedAt)}</td>
                  <td className="px-2 text-right" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                    <button
                      className="grid size-7 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                      aria-label={`Download ${p.title} (.zip)`}
                      title="Download (.zip)"
                      disabled={!!busy}
                      onClick={() => void download(p)}
                    >
                      <ArrowDownTrayIcon className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listError && <p className="px-3 py-2 text-sm text-bad">Saves unavailable: {listError}</p>}
          {projects?.length === 0 && <p className="px-3 py-2 text-sm text-muted">No projects yet. Create one, add the example, or import a .zip.</p>}
          {!!projects?.length && !sorted.length && <p className="px-3 py-2 text-sm text-muted">No matching projects.</p>}
        </div>

        <aside className="flex min-h-0 flex-col overflow-auto rounded-xl border border-line bg-panel p-3.5" aria-label="Project details">
          {project ? (
            <>
              <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-lg border border-line bg-canvas">
                {manifest && active && <ScenePreview key={`${project.id}:${take?.revision.id}`} manifest={manifest} deps={deps} />}
                {!manifest && shown?.error && <span className="text-sm text-muted">Preview unavailable: {shown.error}</span>}
                <LoadingOverlay show={!manifest && !shown?.error} />
                {manifest && manifest.scene.objects.length === 0 && (
                  <span className="pointer-events-none absolute text-sm text-muted">No objects yet</span>
                )}
              </div>
              <h2 className="mt-3 mb-1.5 break-words text-base font-semibold">{project.title}</h2>
              <dl className="text-sm">
                {(
                  [
                    ["Takes", take ? take.takes.map((t) => t.name).join(", ") : "—"],
                    ["Previewing", take ? `${take.revision.manifest.take.name} · revision ${take.revision.number}` : "—"],
                    ["Objects", manifest ? String(manifest.scene.objects.length) : "—"],
                    ["Assets", shown?.value ? `${shown.value.assetCount} · ${size(shown.value.assetBytes)}` : "—"],
                    ["Created", when(project.createdAt)],
                    ["Last edited", when(project.updatedAt)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-panel-2 py-1.5">
                    <dt className="text-muted">{k}</dt>
                    <dd className="truncate text-right" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
                <button className={`${button} justify-center`} onClick={() => void download(project)} disabled={!!busy}>
                  Download (.zip)
                  <ArrowDownTrayIcon className="size-4" />
                </button>
                <button className={`${primary} justify-center`} onClick={() => onOpen(project.id)}>
                  Open
                </button>
              </div>
            </>
          ) : (
            projects?.length === 0 && <p className="text-sm text-muted">Create or import a project to begin.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

/** Live, orbitable preview of a take, framed on its objects once the meshes load. */
function ScenePreview({ manifest, deps }: { manifest: TakeManifest; deps: Parameters<typeof loadProjectAsset>[0] }) {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!el.current) return;
    const loadAsset = async (assetId: string) => {
      const r = await loadProjectAsset(deps, manifest.projectId, assetId);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.value.bytes;
    };
    const vp = new EditorViewport(el.current, { onSelect: () => {}, onTransformEnd: () => {}, loadAsset });
    let live = true;
    void vp.sync(manifest).then(() => {
      if (!live) return;
      vp.frame(null);
      setReady(true);
    });
    return () => {
      live = false;
      vp.dispose();
    };
  }, [manifest, deps]);
  return (
    <>
      <div ref={el} className="absolute inset-0" aria-label="3D preview (drag to orbit)" />
      <LoadingOverlay show={!ready && manifest.scene.objects.length > 0} />
    </>
  );
}
