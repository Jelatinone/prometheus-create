import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TakeManifest, type Asset } from "@/lib/contracts";
import { attachSplat, findObject, setObjectTransform, setSplatEnabled, startHistory, commit, undo } from "@/lib/editor/model";
import { attachedSplat } from "@/lib/editor/reconstruction";
import type { ReconstructionOutcome } from "@/lib/reconstruction/runner";
import { ALL_LAYERS, checkSplatPly, drawsSplat, splatState, wantsSplat } from "@/lib/scene/splat";
import { loadFixture } from "../helpers/fixtures";

const BOX = "obj_fixture_axis_box";
const fixturePly = () => new Uint8Array(readFileSync(resolve(__dirname, "fixtures/box-splat.ply")));
const original = () => loadFixture<TakeManifest>("take-manifest.original.json");

describe("S1 splat PLY check", () => {
  it("accepts the synthetic 3DGS fixture", () => {
    const r = checkSplatPly(fixturePly());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.vertexCount).toBe(3000);
      expect(r.info.strideBytes).toBe(14 * 4);
    }
  });

  it("rejects non-PLY, ASCII, non-splat and truncated files", () => {
    const enc = new TextEncoder();
    expect(checkSplatPly(enc.encode("glTF....")).ok).toBe(false);
    expect(checkSplatPly(enc.encode("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n"))).toMatchObject({ ok: false, reason: "PLY must be binary_little_endian 1.0" });
    const mesh = "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
    expect(checkSplatPly(enc.encode(mesh))).toMatchObject({ ok: false });
    const bytes = fixturePly();
    expect(checkSplatPly(bytes.subarray(0, bytes.length - 10))).toMatchObject({ ok: false, reason: "PLY body is shorter than its header declares" });
  });
});

describe("splat layer edits", () => {
  it("attach shows the splat; the switch is one undoable edit; transforms leave the splat alone", () => {
    const start = original();
    let h = startHistory(start);
    h = commit(h, attachSplat(h.present, BOX, "ast_box_splat_0001"));
    const box = () => findObject(h.present, BOX)!;
    expect(box().splat).toEqual({ assetId: "ast_box_splat_0001", enabled: true, validForGeometryRevision: 1 });
    expect(wantsSplat(box())).toBe(true);

    h = commit(h, setSplatEnabled(h.present, BOX, false));
    expect(wantsSplat(box())).toBe(false);
    expect(splatState(box())).toBe("available");
    h = commit(h, setObjectTransform(h.present, BOX, { ...box().transform, position: [1, 0.45, 0] }));
    expect(box().splat?.assetId).toBe("ast_box_splat_0001");
    h = undo(undo(h));
    expect(box().splat?.enabled).toBe(true);
    expect(TakeManifest.safeParse(h.present).success).toBe(true);
    expect(findObject(start, BOX)!.splat).toBeNull();
  });

  it("layer toggles are view state: the splat draws only with the Splat layer on and the object opted in (ADR-005)", () => {
    const m = attachSplat(original(), BOX, "ast_box_splat_0001");
    const box = findObject(m, BOX)!;
    const before = structuredClone(m);
    expect(drawsSplat(box, ALL_LAYERS)).toBe(true);
    expect(drawsSplat(box, { mesh: false, splat: true })).toBe(true); // independent of the Mesh layer
    expect(drawsSplat(box, { mesh: true, splat: false })).toBe(false);
    expect(drawsSplat(box, { mesh: false, splat: false })).toBe(false);
    expect(drawsSplat(findObject(setSplatEnabled(m, BOX, false), BOX)!, ALL_LAYERS)).toBe(false); // opted out
    expect(drawsSplat(findObject(original(), BOX)!, ALL_LAYERS)).toBe(false); // no splat attached
    expect(drawsSplat({ ...box, geometry: { ...box.geometry, geometryRevision: 2 } }, ALL_LAYERS)).toBe(false); // stale
    expect(m).toEqual(before); // asking never edits the take
  });

  it("a splat for an older geometry revision is stale and never drawn", () => {
    const m = attachSplat(original(), BOX, "ast_box_splat_0001");
    const box = findObject(m, BOX)!;
    const newer = { ...box, geometry: { ...box.geometry, geometryRevision: 2 } };
    expect(splatState(newer)).toBe("stale");
    expect(wantsSplat(newer)).toBe(false);
    expect(setSplatEnabled(original(), BOX, true)).toEqual(original()); // nothing to switch without a splat
  });
});

describe("S3 attach from a reconstruction outcome", () => {
  const job = { projectId: "prj_fixture_demo" } as ReconstructionOutcome["job"];
  const splatAsset = { id: "ast_round_table_splat", kind: "splat", projectId: "prj_fixture_demo" } as Asset;

  it("attaches the outcome's splat asset, off by default, for this geometry revision", () => {
    expect(attachedSplat({ job, splatAsset } as never, 3)).toEqual({ assetId: "ast_round_table_splat", enabled: false, validForGeometryRevision: 3 });
  });

  it("stays mesh-only without a usable splat asset (before S2 lands, null, wrong kind or project)", () => {
    expect(attachedSplat({ job } as never, 1)).toBeNull();
    expect(attachedSplat({ job, splatAsset: null } as never, 1)).toBeNull();
    expect(attachedSplat({ job, splatAsset: { ...splatAsset, kind: "mesh" } } as never, 1)).toBeNull();
    expect(attachedSplat({ job, splatAsset: { ...splatAsset, projectId: "prj_other" } } as never, 1)).toBeNull();
  });
});

describe("placement seam (Track A CP-009, applied after the merge)", () => {
  it("a levelled placement sets the object transform; without one the object stands at the origin", async () => {
    const { reconstructedObject } = await import("@/lib/editor/reconstruction");
    const manifest = original();
    const geometry = { ...findObject(manifest, BOX)!.geometry, assetId: "ast_generated_mesh_0001" };
    const outcome = {
      job: { id: "job_generated00001", projectId: manifest.projectId, state: "succeeded", providerModel: "fal-ai/sam-3/3d-objects", input: { observationId: "obs_frame000001" } },
      apply: { apply: true }, geometry,
    } as unknown as ReconstructionOutcome;
    const observation = { id: "obs_frame000001", projectId: manifest.projectId, sourceId: "src_frame000001" } as never;
    const placed = reconstructedObject(manifest, manifest.take.id, "Table", observation, outcome, { position: [0.3, 0.2, -1.4], rotation: [0, 0.2, 0, 0.98], scale: 0.8 });
    expect(placed.ok && placed.value.transform).toEqual({ position: [0.3, 0.2, -1.4], rotation: [0, 0.2, 0, 0.98], scale: [0.8, 0.8, 0.8] });
    const standing = reconstructedObject(manifest, manifest.take.id, "Table", observation, outcome);
    expect(standing.ok && standing.value.transform.position).toEqual([0, 0.45, 0]);
  });
});

describe("provider splat for a generated object (CP-014)", () => {
  it("attaches only a finished splat whose mesh is this object's mesh", async () => {
    const { providerSplatFor } = await import("@/lib/editor/reconstruction");
    const box = findObject(original(), BOX)!;
    const meshAsset = { id: box.geometry.assetId } as Asset;
    const splatAsset = { id: "ast_round_table_splat", kind: "splat", projectId: "prj_fixture_demo" } as Asset;
    const job = { state: "succeeded", projectId: "prj_fixture_demo" };
    const outcome = (over: Record<string, unknown>) => ({ job, meshAsset, splatAsset, ...over }) as unknown as ReconstructionOutcome;
    const ok = providerSplatFor(box, outcome({}));
    expect(ok.ok && ok.value).toEqual({ assetId: "ast_round_table_splat", enabled: true, validForGeometryRevision: 1 });
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);
    expect(code(providerSplatFor(box, outcome({ meshAsset: { id: "ast_some_other_mesh" } })))).toBe("STALE_REVISION");
    expect(code(providerSplatFor(box, outcome({ splatAsset: null })))).toBe("MISSING_ASSET");
    expect(code(providerSplatFor(box, outcome({ job: { ...job, state: "running" } })))).toBe("INVALID_TRANSITION");
  });
});
