/** Take cameras and capture timing. No provider, DOM or independent path format. */
import { cloneJson } from "@/lib/contracts/canonical";
import { err, newId, ok, type Camera, type Keyframe, type Observation, type Result, type Source, type TakeManifest, type Track, type Transform } from "@/lib/contracts";
import { defaultDurationFrames, framesPerSecond } from "./timeline";

export type CameraView = Pick<Camera, "transform" | "verticalFovDeg" | "near" | "far">;
export type CameraTrack = Extract<Track, { driver: "keyframes" }>;

export function cameraTrack(manifest: TakeManifest, id: string): CameraTrack | null {
  return manifest.take.tracks.find((t): t is CameraTrack => t.driver === "keyframes" && t.target.kind === "camera" && t.target.cameraId === id) ?? null;
}

export function activeCamera(manifest: TakeManifest): Camera | null {
  return manifest.scene.cameras.find(c => c.id === manifest.take.activeCameraId) ?? null;
}

export function chooseCamera(manifest: TakeManifest, id: string): TakeManifest {
  if (!manifest.scene.cameras.some(c => c.id === id) || id === manifest.take.activeCameraId) return manifest;
  return { ...manifest, take: { ...manifest.take, activeCameraId: id } };
}

export function setCameraKey(manifest: TakeManifest, id: string, frame: number, transform: Transform, interpolation: Keyframe["interpolation"] = "smooth"): TakeManifest {
  if (!Number.isInteger(frame) || frame < 0 || frame >= manifest.take.durationFrames || !manifest.scene.cameras.some(c => c.id === id)) return manifest;
  const copy = cloneJson(manifest);
  let track = cameraTrack(copy, id);
  if (!track) {
    copy.take.tracks = copy.take.tracks.filter(t => t.target.kind !== "camera" || t.target.cameraId !== id);
    track = { id: newId("track"), driver: "keyframes", target: { kind: "camera", cameraId: id }, startFrame: 0, endFrame: copy.take.durationFrames, keyframes: [] };
    copy.take.tracks.push(track);
  }
  track.keyframes = [...track.keyframes.filter(k => k.frame !== frame), { frame, transform: cloneJson(transform), interpolation }].sort((a, b) => a.frame - b.frame);
  copy.scene.cameras.find(c => c.id === id)!.origin = "user";
  return copy;
}

export function removeCameraKey(manifest: TakeManifest, id: string, frame: number): TakeManifest {
  const track = cameraTrack(manifest, id);
  if (!track?.keyframes.some(k => k.frame === frame)) return manifest;
  const copy = cloneJson(manifest);
  const edited = cameraTrack(copy, id)!;
  edited.keyframes = edited.keyframes.filter(k => k.frame !== frame);
  if (!edited.keyframes.length) {
    copy.take.tracks = copy.take.tracks.filter(t => t.id !== track.id);
    copy.scene.cameras.find(c => c.id === id)!.transform = cloneJson(track.keyframes[0].transform);
  }
  copy.scene.cameras.find(c => c.id === id)!.origin = "user";
  return copy;
}

export function editCamera(manifest: TakeManifest, id: string, frame: number, pose: Transform): TakeManifest {
  if (cameraTrack(manifest, id)) {
    const interpolation = cameraTrack(manifest, id)!.keyframes.find(k => k.frame === frame)?.interpolation ?? cameraTrack(manifest, id)!.keyframes[0].interpolation;
    return setCameraKey(manifest, id, frame, pose, interpolation);
  }
  const copy = cloneJson(manifest);
  const cam = copy.scene.cameras.find(c => c.id === id);
  if (!cam) return manifest;
  cam.transform = cloneJson(pose);
  cam.origin = "user";
  return copy;
}

export function moveCameraKey(manifest: TakeManifest, id: string, from: number, to: number): Result<TakeManifest> {
  const track = cameraTrack(manifest, id);
  if (!track?.keyframes.some(k => k.frame === from)) return err("NOT_FOUND", "This camera key no longer exists.");
  if (!Number.isInteger(to) || to < 0 || to >= manifest.take.durationFrames) return err("INVALID_SCHEMA", "Put the key inside the take's frame range.");
  if (from !== to && track.keyframes.some(k => k.frame === to)) return err("INVALID_SCHEMA", "A camera key already exists at that frame.");
  const copy = cloneJson(manifest);
  const edited = cameraTrack(copy, id)!;
  edited.keyframes.find(k => k.frame === from)!.frame = to;
  edited.keyframes.sort((a, b) => a.frame - b.frame);
  copy.scene.cameras.find(c => c.id === id)!.origin = "user";
  return ok(copy);
}

export function cameraInterpolation(manifest: TakeManifest, id: string, interpolation: Keyframe["interpolation"]): TakeManifest {
  const copy = cloneJson(manifest);
  const track = cameraTrack(copy, id);
  if (!track) return manifest;
  track.keyframes.forEach(k => { k.interpolation = interpolation; });
  copy.scene.cameras.find(c => c.id === id)!.origin = "user";
  return copy;
}

export function cameraFromView(manifest: TakeManifest, view: CameraView, frame: number, key: boolean): TakeManifest {
  const copy = cloneJson(manifest);
  let cam = activeCamera(copy);
  if (!cam) {
    cam = { ...cloneJson(view), id: newId("camera"), name: "Camera", origin: "user", observationId: null };
    copy.scene.cameras.push(cam);
    copy.take.activeCameraId = cam.id;
  }
  cam.verticalFovDeg = view.verticalFovDeg;
  cam.near = view.near;
  cam.far = view.far;
  cam.origin = "user";
  if (!key) return editCamera(copy, cam.id, frame, view.transform);
  if (!copy.take.durationFrames) copy.take.durationFrames = defaultDurationFrames(copy.take.frameRate);
  return setCameraKey(copy, cam.id, Math.min(frame, copy.take.durationFrames - 1), view.transform, cameraTrack(copy, cam.id)?.keyframes[0].interpolation ?? "smooth");
}

export function cameraFov(manifest: TakeManifest, id: string, degrees: number): TakeManifest {
  if (!Number.isFinite(degrees) || degrees <= 0 || degrees >= 180) return manifest;
  const copy = cloneJson(manifest);
  const cam = copy.scene.cameras.find(c => c.id === id);
  if (!cam) return manifest;
  cam.verticalFovDeg = degrees;
  cam.origin = "user";
  return copy;
}

/** Changing the end does not retime or silently discard authored keys. */
export function resizeTake(manifest: TakeManifest, frames: number): Result<TakeManifest> {
  if (!Number.isSafeInteger(frames) || frames < 0) return err("INVALID_SCHEMA", "Duration must be a whole, nonnegative number of take frames.");
  const minimum = Math.max(0, ...manifest.take.sourceMappings.map(m => m.takeOutFrame), ...manifest.take.tracks.map(t => t.driver === "keyframes" ? Math.max(t.startFrame + 1, ...t.keyframes.map(k => k.frame + 1)) : t.endFrame));
  if (frames < minimum) return err("INVALID_SCHEMA", `Move or remove the later keys first. This take needs at least ${minimum} frames.`);
  const copy = cloneJson(manifest);
  for (const track of copy.take.tracks) {
    if (track.driver === "keyframes" && track.endFrame === manifest.take.durationFrames) track.endFrame = frames;
    else if (track.endFrame > frames) return err("INVALID_SCHEMA", `A track extends beyond frame ${frames}. Shorten it first.`);
  }
  copy.take.durationFrames = frames;
  return ok(copy);
}

export interface CaptureTiming { startUs: number; durationUs: number; frames: number; label: string }

/** A video has real duration metadata; live duration is the evidence span plus its final take frame. */
export function captureTiming(source: Source, observations: Observation[], rate: TakeManifest["take"]["frameRate"]): CaptureTiming | null {
  if (source.media.kind === "image") return null;
  const fps = framesPerSecond(rate);
  if (source.media.kind === "video") return { startUs: 0, durationUs: source.media.durationUs, frames: Math.ceil(source.media.durationUs * fps / 1_000_000), label: "Video duration" };
  const times = observations.filter(o => o.mode === "evidence" && o.sourceId === source.id).map(o => o.sourceTimeUs);
  if (times.length < 2) return null;
  const startUs = Math.min(...times);
  const span = Math.max(...times) - startUs;
  if (span <= 0) return null;
  const frames = Math.ceil(span * fps / 1_000_000) + 1;
  return { startUs, durationUs: frames / fps * 1_000_000, frames, label: "Recorded span (including final frame)" };
}

export function seedCamera(manifest: TakeManifest, source: Source, observations: Observation[]): Result<TakeManifest> {
  const timing = captureTiming(source, observations, manifest.take.frameRate);
  const estimates = observations.filter(o => o.sourceId === source.id && o.mode === "evidence" && o.camera !== null).sort((a, b) => a.sourceTimeUs - b.sourceTimeUs || a.sequence - b.sequence);
  if (!estimates.length) return err("NOT_FOUND", "This capture has no camera pose estimates. Author camera keys from your view instead.");
  const first = estimates[0];
  const estimate = first.camera!;
  const startUs = timing?.startUs ?? first.sourceTimeUs;
  const fps = framesPerSecond(manifest.take.frameRate);
  const keys = new Map<number, Keyframe>();
  for (const observation of estimates) {
    const frame = Math.max(0, Math.round((observation.sourceTimeUs - startUs) * fps / 1_000_000));
    keys.set(frame, { frame, transform: cloneJson(observation.camera!.pose), interpolation: "smooth" });
  }
  const copy = cloneJson(manifest);
  copy.take.durationFrames = Math.max(copy.take.durationFrames, timing?.frames ?? 0, ...[...keys.keys()].map(f => f + 1));
  const cam: Camera = { id: newId("camera"), name: "Capture camera", verticalFovDeg: estimate.verticalFovDeg, near: 0.01, far: 200, transform: cloneJson(estimate.pose), origin: "source_estimate", observationId: first.id };
  copy.scene.cameras.push(cam);
  copy.take.activeCameraId = cam.id;
  copy.take.tracks.push({ id: newId("track"), target: { kind: "camera", cameraId: cam.id }, startFrame: 0, endFrame: copy.take.durationFrames, driver: "keyframes", keyframes: [...keys.values()] });
  return ok(copy);
}
