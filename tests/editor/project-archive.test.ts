import { describe, expect, it } from "vitest";
import { canonicalJson, newId, TakeManifest, type Asset, type Result } from "@/lib/contracts";
import { MemoryBlobStore, storeProjectAsset } from "@/lib/capture";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { findObject, setObjectTransform } from "@/lib/editor/model";
import { buildZip, exportProject, importProject, readZip } from "@/lib/editor/project-archive";
import { forkTake, loadTake, saveTake } from "@/lib/editor/session";
import { loadFixture } from "../helpers/fixtures";
import { readFileSync } from "node:fs";

function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

const BOX = "obj_fixture_axis_box";

/** A project with the real axis-box GLB in storage, an original and an edited fork. */
async function seed() {
  const backend = new MemoryBackend();
  const blobs = new MemoryBlobStore();
  const actor = { userId: "archive-test" };
  const deps = { projects: backend.projects, assets: backend.assets, blobs, actor };
  const projectId = newId("project");
  const takeId = newId("take");
  const fixture = JSON.parse(JSON.stringify(loadFixture<TakeManifest>("take-manifest.original.json")).replaceAll("prj_fixture_demo", projectId).replaceAll("tk_fixture_original", takeId)) as TakeManifest;
  const empty = { ...fixture, scene: { ...fixture.scene, objects: [] } };
  expectOk(await backend.projects.createProject(actor, { projectId, title: "Archive test", initialManifest: empty, idempotencyKey: "create-archive-test" }));
  const glb = new Uint8Array(readFileSync("public/fixtures/axis-box.glb"));
  const asset: Asset = expectOk(await storeProjectAsset(deps, projectId, glb, { kind: "mesh", mimeType: "model/gltf-binary", origin: "fixture" }));
  const original = JSON.parse(JSON.stringify(fixture).replaceAll("ast_fixture_axis_box", asset.id)) as TakeManifest;
  expectOk(await saveTake(backend.projects, actor, original, 1));
  const fork = expectOk(await forkTake(backend.projects, actor, { projectId, takeId, revision: 2 }, "Alternate"));
  const forked = expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId));
  const box = findObject(forked.revision.manifest, BOX)!;
  expectOk(await saveTake(backend.projects, actor, setObjectTransform(forked.revision.manifest, BOX, { ...box.transform, position: [0.7, 0.45, 0] }), 1));
  return { deps, projectId, glb };
}

describe("project archive", () => {
  it("zip round-trips names and bytes", async () => {
    const files = [{ name: "project.json", bytes: new TextEncoder().encode("{}") }, { name: "assets/a.bin", bytes: new Uint8Array([0, 1, 2, 255]) }];
    const read = await readZip(buildZip(files));
    expect([...read.keys()]).toContain("assets/a.bin");
    expect(read.get("assets/a.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it("download then import recreates both takes and the mesh bytes in a new project", async () => {
    const { deps, projectId, glb } = await seed();
    const exported = expectOk(await exportProject(deps, projectId));
    const imported = expectOk(await importProject(deps, exported.zip));
    expect(imported.projectId).not.toBe(projectId);

    const takes = expectOk(await deps.projects.listTakes(deps.actor, imported.projectId));
    expect(takes.map((t) => t.name).sort()).toEqual(["Alternate", "Original"]);
    const alt = takes.find((t) => t.name === "Alternate")!;
    expect(alt.parent).not.toBeNull();
    const altHead = expectOk(await deps.projects.getRevision(deps.actor, imported.projectId, alt.takeId));
    const box = findObject(altHead.manifest, BOX)!;
    expect(box.transform.position).toEqual([0.7, 0.45, 0]);
    expect(TakeManifest.safeParse(altHead.manifest).success).toBe(true);
    expect(canonicalJson(altHead.manifest)).not.toContain(projectId);

    const asset = expectOk(await deps.assets.getAsset(deps.actor, imported.projectId, box.geometry.assetId));
    expect(expectOk(await deps.blobs.get(asset.storageKey)).bytes).toEqual(glb);

    // A second import of the same archive is another independent project.
    const again = expectOk(await importProject(deps, exported.zip));
    expect(again.projectId).not.toBe(imported.projectId);
  });

  it("rejects something that is not a project archive", async () => {
    const { deps } = await seed();
    const notZip = await importProject(deps, new TextEncoder().encode("hello"));
    expect(notZip.ok ? "ok" : notZip.error.code).toBe("INVALID_SCHEMA");
    const wrong = await importProject(deps, buildZip([{ name: "project.json", bytes: new TextEncoder().encode('{"format":"other"}') }]));
    expect(wrong.ok ? "ok" : wrong.error.message).toMatch(/not a Prometheus::create project archive/);
  });
});
