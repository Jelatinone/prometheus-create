import { describe, expect, it } from "vitest";
import { canonicalJson, newId, objectDimensions, TakeManifest, type Asset, type Result } from "@/lib/contracts";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import {
  cleanTransform,
  commit,
  duplicateObject,
  eulerDegToQuat,
  findObject,
  quatToEulerDeg,
  redo,
  removeObject,
  setObjectTransform,
  startHistory,
  undo,
  withUniformScale,
} from "@/lib/editor/model";
import { forkTake, loadTake, nextTakeName, saveTake } from "@/lib/editor/session";
import { loadFixture } from "../helpers/fixtures";

function expectOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function retarget<T>(fixture: T, ids: Record<string, string>): T {
  let text = JSON.stringify(fixture);
  for (const [from, to] of Object.entries(ids)) text = text.replaceAll(from, to);
  return JSON.parse(text) as T;
}

const BOX = "obj_fixture_axis_box";
const original = () => loadFixture<TakeManifest>("take-manifest.original.json");

describe("editor model", () => {
  it("reads 0.400 x 0.900 x 0.200 m for the unscaled axis box", () => {
    const box = findObject(original(), BOX)!;
    expect(objectDimensions(box).map((d) => d.toFixed(3))).toEqual(["0.400", "0.900", "0.200"]);
  });

  it("edits never mutate the input, and undo restores a byte-identical manifest", () => {
    const start = original();
    const before = canonicalJson(start);
    let h = startHistory(start);
    const box = findObject(start, BOX)!;
    h = commit(h, setObjectTransform(h.present, BOX, { ...box.transform, position: [1, 0.45, 0] }));
    h = commit(h, setObjectTransform(h.present, BOX, withUniformScale(findObject(h.present, BOX)!.transform, 2)!));
    expect(canonicalJson(start)).toBe(before);
    expect(objectDimensions(findObject(h.present, BOX)!)[1]).toBeCloseTo(1.8);

    h = undo(h);
    expect(findObject(h.present, BOX)!.transform.scale).toEqual([1, 1, 1]);
    h = undo(h);
    expect(canonicalJson(h.present)).toBe(before);
    h = redo(redo(h));
    expect(findObject(h.present, BOX)!.transform.position).toEqual([1, 0.45, 0]);
    expect(TakeManifest.safeParse(h.present).success).toBe(true);
  });

  it("a no-op edit records nothing", () => {
    const h = startHistory(original());
    const box = findObject(h.present, BOX)!;
    expect(commit(h, setObjectTransform(h.present, BOX, box.transform))).toBe(h);
  });

  it("rejects a non-positive uniform scale", () => {
    const t = findObject(original(), BOX)!.transform;
    expect(withUniformScale(t, 0)).toBeNull();
    expect(withUniformScale(t, Number.NaN)).toBeNull();
  });

  it("Euler degrees round-trip through quaternions", () => {
    const q = eulerDegToQuat([10, 45, -30]);
    quatToEulerDeg(q).forEach((v, i) => expect(v).toBeCloseTo([10, 45, -30][i], 6));
    expect(cleanTransform({ position: [1e-12, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }).position[0]).toBe(0);
  });

  it("duplicate and remove keep the manifest valid", () => {
    const dup = duplicateObject(original(), BOX, newId("object"));
    expect(dup.scene.objects).toHaveLength(2);
    expect(TakeManifest.safeParse(dup).success).toBe(true);
    const removed = removeObject(dup, BOX);
    expect(removed.scene.objects).toHaveLength(1);
    expect(TakeManifest.safeParse(removed).success).toBe(true);
  });
});

describe("take session over the ProjectRepository port", () => {
  async function seed() {
    const backend = new MemoryBackend();
    const actor = { userId: "editor-test" };
    const projectId = newId("project");
    const takeId = newId("take");
    const assetId = newId("asset");
    const ids = { prj_fixture_demo: projectId, tk_fixture_original: takeId, ast_fixture_axis_box: assetId };
    const manifest = retarget(original(), ids);
    const empty: TakeManifest = { ...manifest, scene: { ...manifest.scene, objects: [] } };
    expectOk(
      await backend.projects.createProject(actor, { projectId, title: "Editor test", initialManifest: empty, idempotencyKey: "create-editor-test" }),
    );
    expectOk(await backend.assets.putAsset(actor, retarget(loadFixture<Asset>("asset.axis-box.json"), ids)));
    expectOk(await saveTake(backend.projects, actor, manifest, 1)); // head = revision 2, with the box
    return { backend, actor, projectId, takeId, manifest };
  }

  it("fork, edit the fork, save, and the original stays unchanged", async () => {
    const { backend, actor, projectId, takeId, manifest } = await seed();
    const loaded = expectOk(await loadTake(backend.projects, actor, projectId));
    expect(loaded.revision.takeId).toBe(takeId);

    const fork = expectOk(await forkTake(backend.projects, actor, { projectId, takeId, revision: loaded.revision.number }, nextTakeName(loaded.takes)));
    const forked = expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId));
    expect(forked.takes.map((t) => t.name).sort()).toEqual(["Alternate", "Original"]);
    const box = findObject(forked.revision.manifest, BOX)!;
    const edited = setObjectTransform(forked.revision.manifest, BOX, { ...box.transform, position: [0.6, 0.45, 0.1] });
    const saved = expectOk(await saveTake(backend.projects, actor, edited, forked.revision.number));
    expect(saved.revision).toBe(2); // the fork starts at 1

    const reloadedFork = expectOk(await loadTake(backend.projects, actor, projectId, fork.takeId));
    expect(findObject(reloadedFork.revision.manifest, BOX)!.transform.position).toEqual([0.6, 0.45, 0.1]);
    const reloadedOriginal = expectOk(await loadTake(backend.projects, actor, projectId, takeId));
    expect(canonicalJson(reloadedOriginal.revision.manifest)).toBe(canonicalJson(manifest));
  });

  it("a stale save returns REVISION_CONFLICT instead of overwriting", async () => {
    const { backend, actor, manifest } = await seed();
    expectOk(await saveTake(backend.projects, actor, setObjectTransform(manifest, BOX, { ...findObject(manifest, BOX)!.transform, position: [2, 0, 0] }), 2));
    const stale = await saveTake(backend.projects, actor, manifest, 2);
    expect(stale.ok ? "ok" : stale.error.code).toBe("REVISION_CONFLICT");
  });

  it("names forks without collisions", () => {
    const t = (name: string) => ({ takeId: newId("take"), name, headRevision: 1, headRevisionId: newId("revision"), parent: null, updatedAt: new Date().toISOString() });
    expect(nextTakeName([t("Original")])).toBe("Alternate");
    expect(nextTakeName([t("Original"), t("Alternate"), t("Alternate 2")])).toBe("Alternate 3");
  });
});
