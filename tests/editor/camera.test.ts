import { describe, expect, it } from "vitest";
import { TakeManifest, type Observation, type Result, type Source, type Transform } from "@/lib/contracts";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { activeCamera, cameraFromView, cameraTrack, captureTiming, removeCameraKey, resizeTake, seedCamera, setCameraKey } from "@/lib/editor/camera";
import { commit, eulerDegToQuat, startHistory, undo } from "@/lib/editor/model";
import { evaluateAt, poseAt, setKey } from "@/lib/editor/timeline";
import { forkTake, loadTake, saveTake } from "@/lib/editor/session";
import { loadFixture } from "../helpers/fixtures";

const base = () => loadFixture<TakeManifest>("take-manifest.original.json");
function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.message); return r.value; }
const pose = (x: number, y = 1, z = 3): Transform => ({ position: [x, y, z], rotation: eulerDegToQuat([0, 0, 0]), scale: [1, 1, 1] });

describe("camera keys and spline", () => {
  it("linear and step retain their meaning; smooth position passes its keys and bends between them", () => {
    const keys = [0, 10, 30, 40].map((frame, i) => ({ frame, transform: pose(i < 2 ? 0 : 2, i % 2), interpolation: "smooth" as const }));
    expect(poseAt(keys, 10)).toEqual(keys[1].transform);
    expect(poseAt(keys, 30)).toEqual(keys[2].transform);
    expect(poseAt(keys, 5).position[0]).not.toBe(0);
    expect(poseAt(keys.map(k => ({ ...k, interpolation: "linear" as const })), 5).position[0]).toBe(0);
    expect(poseAt(keys.map(k => ({ ...k, interpolation: "step" as const })), 29)).toEqual(keys[1].transform);
    expect(poseAt(keys, -1)).toEqual(keys[0].transform);
    expect(poseAt(keys, 50)).toEqual(keys[3].transform);
  });

  it("evaluates camera and object clocks together without changing base poses; last key removal retains its pose", () => {
    let m = value(resizeTake(base(), 240));
    const id = activeCamera(m)!.id;
    const original = structuredClone(activeCamera(m)!.transform);
    m = setCameraKey(m, id, 0, pose(0), "linear");
    m = setCameraKey(m, id, 120, { ...pose(2), rotation: eulerDegToQuat([0, 90, 0]) }, "linear");
    expect(TakeManifest.safeParse(m).success).toBe(true);
    const middle = activeCamera(evaluateAt(m, 60))!;
    expect(middle.transform.position[0]).toBeCloseTo(1);
    eulerDegToQuat([0, 45, 0]).forEach((q, i) => expect(middle.transform.rotation[i]).toBeCloseTo(q));
    expect(activeCamera(m)!.transform).toEqual(original);
    m = removeCameraKey(m, id, 0);
    m = removeCameraKey(m, id, 120);
    expect(cameraTrack(m, id)).toBeNull();
    expect(activeCamera(m)!.transform.position).toEqual([2, 1, 3]);
    expect(TakeManifest.safeParse(m).success).toBe(true);
  });

  it("creates a render camera from a view and uses one transform driver; arbitrary duration does not lose later keys", () => {
    const empty = base();
    empty.scene.cameras = [];
    empty.take.activeCameraId = null;
    let m = cameraFromView(empty, { transform: pose(1), verticalFovDeg: 50, near: 0.01, far: 200 }, 0, true);
    const id = activeCamera(m)!.id;
    m = value(resizeTake(m, 300));
    m = setCameraKey(m, id, 250, pose(3));
    expect(value(resizeTake(m, 270)).take.durationFrames).toBe(270);
    expect(resizeTake(m, 200).ok).toBe(false);
    expect(resizeTake(m, 1.5).ok).toBe(false);
    expect(resizeTake(m, Number.NaN).ok).toBe(false);
    expect(TakeManifest.safeParse(m).success).toBe(true);
    expect(cameraTrack(m, id)!.keyframes.map(k => k.frame)).toEqual([0, 250]);
  });

  it("undo, save/reload and fork preserve independent camera tracks on the existing backend", async () => {
    const backend = new MemoryBackend();
    const actor = { userId: "camera-test" };
    const initial = base();
    initial.scene.objects = [];
    value(await backend.projects.createProject(actor, { projectId: initial.projectId, title: "Camera test", initialManifest: initial, idempotencyKey: "camera-create" }));
    const length = value(resizeTake(initial, 240));
    const id = activeCamera(length)!.id;
    const keyed = setCameraKey(length, id, 90, pose(2));
    const h = commit(startHistory(length), keyed);
    expect(undo(h).present).toEqual(length);
    value(await saveTake(backend.projects, actor, keyed, 1));
    const saved = value(await loadTake(backend.projects, actor, initial.projectId));
    expect(saved.revision.manifest).toEqual(keyed);
    const fork = value(await forkTake(backend.projects, actor, { projectId: initial.projectId, takeId: initial.take.id, revision: 2 }, "Camera alternate"));
    const forked = value(await loadTake(backend.projects, actor, initial.projectId, fork.takeId));
    const changed = setCameraKey(forked.revision.manifest, id, 90, pose(5));
    value(await saveTake(backend.projects, actor, changed, 1));
    const unchanged = value(await loadTake(backend.projects, actor, initial.projectId, initial.take.id));
    expect(cameraTrack(unchanged.revision.manifest, id)!.keyframes[0].transform.position[0]).toBe(2);
    expect(TakeManifest.safeParse(changed).success).toBe(true);
  });
});

const source = () => loadFixture<Source>("source.chert-live.json");
function observation(time: number, camera: Observation["camera"] = null, mode: Observation["mode"] = "evidence"): Observation {
  return { schemaVersion: 1, id: `obs_camera_${time}`, projectId: "prj_fixture_demo", sourceId: source().id, sequence: time, sourceTimeUs: time,
    frame: { assetId: "ast_fixture_frame", mimeType: "image/jpeg", byteSize: 100, width: 1280, height: 720, contentHash: "sha256:" + "a".repeat(64) }, maskAssetIds: [], objectId: null, camera,
    quality: { status: "usable", score: null }, mode, capturedAt: null, receivedAt: "2026-11-15T10:00:00Z", outOfOrder: false };
}

describe("capture timing and genuine camera estimates", () => {
  it("live timing uses source-time evidence, ignoring previews and wall-clock arrival; video uses metadata", () => {
    const observations = [observation(10_000_000), observation(17_000_000), observation(80_000_000, null, "preview")];
    const timing = captureTiming(source(), observations, { num: 30, den: 1 })!;
    expect(timing.startUs).toBe(10_000_000);
    expect(timing.frames).toBe(211);
    const video: Source = { ...source(), media: { kind: "video", width: 1280, height: 720, mimeType: "video/mp4", nominalFrameRate: null, durationUs: 8_000_000 } };
    expect(captureTiming(video, [], { num: 30000, den: 1001 })!.frames).toBe(240);
    expect(captureTiming(source(), [observation(0)], base().take.frameRate)).toBeNull();
    expect(captureTiming(loadFixture<Source>("source.image-upload.json"), observations, base().take.frameRate)).toBeNull();
  });

  it("does not fabricate camera motion when estimates are absent; real estimates retain their evidence link", () => {
    expect(seedCamera(base(), source(), [observation(0), observation(7_000_000)]).ok).toBe(false);
    const estimate: NonNullable<Observation["camera"]> = { verticalFovDeg: 50, aspect: 16 / 9, pose: pose(0), status: "estimated", method: "fixture-camera" };
    const observations = [observation(10_000_000, estimate), observation(17_000_000, { ...estimate, pose: pose(2) })];
    const seeded = value(seedCamera(base(), source(), observations));
    const cam = activeCamera(seeded)!;
    expect(cam.origin).toBe("source_estimate");
    expect(cam.observationId).toBe(observations[0].id);
    expect(cameraTrack(seeded, cam.id)!.keyframes.map(k => k.frame)).toEqual([0, 210]);
    expect(seeded.take.durationFrames).toBe(211);
    expect(TakeManifest.safeParse(seeded).success).toBe(true);
    expect(activeCamera(setCameraKey(seeded, cam.id, 20, pose(3)))!.origin).toBe("user");
  });

  it("extending a take from capture estimates preserves the existing object's held final pose", () => {
    let initial = value(resizeTake(base(), 60));
    const object = initial.scene.objects[0];
    initial = setKey(initial, object.id, 30, { ...object.transform, position: [2, 1, 0] });
    const estimate: NonNullable<Observation["camera"]> = { verticalFovDeg: 50, aspect: 16 / 9, pose: pose(0), status: "estimated", method: "fixture-camera" };
    const seeded = value(seedCamera(initial, source(), [observation(0, estimate), observation(7_000_000, estimate)]));
    expect(seeded.take.durationFrames).toBe(211);
    expect(evaluateAt(seeded, 180).scene.objects[0].transform.position).toEqual([2, 1, 0]);
    expect(TakeManifest.safeParse(seeded).success).toBe(true);
  });
});
