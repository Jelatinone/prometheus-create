import { describe, expect, it } from "vitest";
import { canonicalJson, newId, TakeManifest, type Asset, type Result } from "@/lib/contracts";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { attachSplat, commit, eulerDegToQuat, findObject, setObjectTransform, setSplatEnabled, startHistory, undo, withUniformScale } from "@/lib/editor/model";
import { forkTake, loadTake, saveTake } from "@/lib/editor/session";
import { wantsSplat } from "@/lib/scene/splat";
import { loadFixture } from "../helpers/fixtures";

/**
 * CP-012: the splat is an appearance layer of the object, not a second object.
 * It carries no transform of its own, so every object transform applies to both
 * layers exactly once, and undo, fork and save/reload move them together.
 */
const BOX = "obj_fixture_axis_box";

function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

const retarget = <T,>(v: T, ids: Record<string, string>): T => {
  let t = JSON.stringify(v);
  for (const [a, b] of Object.entries(ids)) t = t.replaceAll(a, b);
  return JSON.parse(t) as T;
};

async function seedWithSplat() {
  const backend = new MemoryBackend();
  const actor = { userId: "shared-transform" };
  const projectId = newId("project");
  const takeId = newId("take");
  const ids = { prj_fixture_demo: projectId, tk_fixture_original: takeId, ast_fixture_axis_box: newId("asset") };
  const manifest = retarget(loadFixture<TakeManifest>("take-manifest.original.json"), ids);
  expectOk(await backend.projects.createProject(actor, { projectId, title: "Shared transform", initialManifest: { ...manifest, scene: { ...manifest.scene, objects: [] } }, idempotencyKey: "create-shared-transform" }));
  expectOk(await backend.assets.putAsset(actor, retarget(loadFixture<Asset>("asset.axis-box.json"), ids)));
  const splatId = newId("asset");
  expectOk(await backend.assets.putAsset(actor, { ...retarget(loadFixture<Asset>("asset.axis-box.json"), ids), id: splatId, kind: "splat", mimeType: "application/octet-stream" }));
  expectOk(await saveTake(backend.projects, actor, attachSplat(manifest, BOX, splatId), 1));
  return { backend, actor, projectId, takeId, splatId };
}

describe("one object transform drives both layers", () => {
  it("translate, rotate and uniform scale change only the object transform; the splat reference is untouched", () => {
    let h = startHistory(attachSplat(loadFixture<TakeManifest>("take-manifest.original.json"), BOX, "ast_splat_0001"));
    const splatBefore = canonicalJson(findObject(h.present, BOX)!.splat);
    const t0 = findObject(h.present, BOX)!.transform;
    h = commit(h, setObjectTransform(h.present, BOX, { ...t0, position: [0.6, 0.45, -0.2] }));
    h = commit(h, setObjectTransform(h.present, BOX, { ...findObject(h.present, BOX)!.transform, rotation: eulerDegToQuat([0, 45, 0]) }));
    h = commit(h, setObjectTransform(h.present, BOX, withUniformScale(findObject(h.present, BOX)!.transform, 1.5)!));
    const moved = findObject(h.present, BOX)!;
    expect(canonicalJson(moved.splat)).toBe(splatBefore);
    expect(moved.transform.position).toEqual([0.6, 0.45, -0.2]);
    expect(moved.transform.scale).toEqual([1.5, 1.5, 1.5]);
    // The geometry normalization (applied once, when the mesh was stored) is not touched by edits.
    expect(moved.geometry).toEqual(findObject(h.past[0], BOX)!.geometry);
    h = undo(undo(undo(h)));
    expect(findObject(h.present, BOX)!.transform).toEqual(t0);
    expect(canonicalJson(findObject(h.present, BOX)!.splat)).toBe(splatBefore);
  });

  it("fork, edit the fork with the splat showing, save, reload: both takes keep their own pose and the same splat", async () => {
    const { backend, actor, projectId, takeId, splatId } = await seedWithSplat();
    const original = expectOk(await loadTake(backend.projects, actor, projectId));
    const fork = expectOk(await forkTake(backend.projects, actor, { projectId, takeId, revision: original.revision.number }, "Alternate"));
    const forked = expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId));
    const box = findObject(forked.revision.manifest, BOX)!;
    const edited = setObjectTransform(forked.revision.manifest, BOX, { ...box.transform, position: [0.8, 0.45, 0], rotation: eulerDegToQuat([0, 30, 0]), scale: [1.25, 1.25, 1.25] });
    expectOk(await saveTake(backend.projects, actor, edited, forked.revision.number));

    const reFork = findObject(expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId)).revision.manifest, BOX)!;
    const reOriginal = findObject(expectOk(await loadTake(backend.projects, actor, projectId, takeId)).revision.manifest, BOX)!;
    expect(reFork.transform.position).toEqual([0.8, 0.45, 0]);
    expect(reFork.transform.scale).toEqual([1.25, 1.25, 1.25]);
    expect(reOriginal.transform.position).toEqual([0, 0.45, 0]);
    for (const o of [reFork, reOriginal]) {
      expect(o.splat).toEqual({ assetId: splatId, enabled: true, validForGeometryRevision: 1 });
      expect(wantsSplat(o)).toBe(true);
    }
  });

  it("the saved splat flag is per take (display itself follows the Layers menu)", async () => {
    const { backend, actor, projectId, takeId } = await seedWithSplat();
    const original = expectOk(await loadTake(backend.projects, actor, projectId));
    const fork = expectOk(await forkTake(backend.projects, actor, { projectId, takeId, revision: original.revision.number }, "Mesh only"));
    const forked = expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId));
    expectOk(await saveTake(backend.projects, actor, setSplatEnabled(forked.revision.manifest, BOX, false), forked.revision.number));
    expect(findObject(expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId)).revision.manifest, BOX)!.splat?.enabled).toBe(false);
    expect(findObject(expectOk(await loadTake(backend.projects, actor, projectId, takeId)).revision.manifest, BOX)!.splat?.enabled).toBe(true);
    expect(wantsSplat(findObject(expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId)).revision.manifest, BOX)!)).toBe(true);
  });
});
