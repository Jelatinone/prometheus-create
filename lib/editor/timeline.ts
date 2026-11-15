/**
 * Take timeline (CP-013). Pure: no DOM, no provider, no network.
 *
 * Two clocks stay distinct (PLAN §4):
 *   take time   — integer frames at the take's rational rate; the playhead
 *   source time — integer µs of a captured source, reached only through a
 *                 take's sourceMappings (never by treating take time as source time)
 *
 * The evaluated scene at a frame replaces each object's base transform with its
 * `keyframes` track pose inside the track interval (linear position/scale,
 * slerped rotation, or step). Other drivers (observed, simulation) are not
 * evaluated here and leave the base pose. Evaluation copies only transforms.
 */
import { Quaternion } from "three";
import { cloneJson } from "@/lib/contracts/canonical";
import { newId, type Quat, type Rational, type Transform, type Vec3 } from "@/lib/contracts/common";
import type { TakeManifest } from "@/lib/contracts/revision";
import type { Keyframe, SceneObject, Track } from "@/lib/contracts/scene";
import { DEFAULT_TAKE_SECONDS, activeMapping, frameToMicroseconds, sourceTimeAtTakeFrame } from "@/lib/contracts/time";

type KeyTrack = Extract<Track, { driver: "keyframes" }>;

export function framesPerSecond(rate: Rational): number {
  return rate.num / rate.den;
}

/** Frames for the default playback take (5 s at the take's rate). */
export function defaultDurationFrames(rate: Rational): number {
  return Math.round(DEFAULT_TAKE_SECONDS * framesPerSecond(rate));
}

/** "00:02.40" for a take frame (minutes:seconds.hundredths of take time). */
export function formatTakeTime(frame: number, rate: Rational): string {
  return formatMicroseconds(frameToMicroseconds(frame, rate));
}

export function formatMicroseconds(us: number): string {
  const total = Math.max(0, us) / 1_000_000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Source time shown at a take frame, or null when no mapping covers it. Distinct from take time. */
export function sourceAt(manifest: TakeManifest, frame: number): { sourceId: string; us: number } | null {
  const mapping = activeMapping(manifest.take.sourceMappings, frame);
  if (!mapping) return null;
  const us = sourceTimeAtTakeFrame(mapping, frame, manifest.take.frameRate);
  return us === null ? null : { sourceId: mapping.sourceId, us };
}

export function keyTrackOf(manifest: TakeManifest, objectId: string): KeyTrack | null {
  return (manifest.take.tracks.find((t) => t.driver === "keyframes" && t.target.kind === "object" && t.target.objectId === objectId) as KeyTrack | undefined) ?? null;
}

export function keyFrames(manifest: TakeManifest, objectId: string): number[] {
  return keyTrackOf(manifest, objectId)?.keyframes.map((k) => k.frame) ?? [];
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  const q = new Quaternion(a[0], a[1], a[2], a[3]).slerp(new Quaternion(b[0], b[1], b[2], b[3]), t);
  return [q.x, q.y, q.z, q.w];
}

/** The pose a keyframe track gives at a frame (frame assumed inside the track interval). */
export function poseAt(keyframes: Keyframe[], frame: number): Transform {
  if (frame <= keyframes[0].frame) return keyframes[0].transform;
  const last = keyframes[keyframes.length - 1];
  if (frame >= last.frame) return last.transform;
  const i = keyframes.findIndex((k) => k.frame > frame);
  const a = keyframes[i - 1];
  const b = keyframes[i];
  if (a.interpolation === "step") return a.transform;
  const t = (frame - a.frame) / (b.frame - a.frame);
  return { position: lerp(a.transform.position, b.transform.position, t), rotation: slerp(a.transform.rotation, b.transform.rotation, t), scale: lerp(a.transform.scale, b.transform.scale, t) };
}

/** The scene shown at a take frame: animated objects take their track pose, others keep the base. */
export function evaluateAt(manifest: TakeManifest, frame: number): TakeManifest {
  const animated = manifest.take.tracks.filter(
    (t): t is KeyTrack => t.driver === "keyframes" && t.target.kind === "object" && frame >= t.startFrame && frame < t.endFrame,
  );
  if (!animated.length) return manifest;
  const byObject = new Map(animated.map((t) => [(t.target as { objectId: string }).objectId, t]));
  return {
    ...manifest,
    scene: {
      ...manifest.scene,
      objects: manifest.scene.objects.map((o): SceneObject => {
        const track = byObject.get(o.id);
        return track ? { ...o, transform: poseAt(track.keyframes, frame) } : o;
      }),
    },
  };
}

/** Turns a still take into a playback take (default 5 s); never shortens below existing tracks or mappings. */
export function setDuration(manifest: TakeManifest, frames: number): TakeManifest {
  const minimum = Math.max(0, ...manifest.take.tracks.map((t) => t.endFrame), ...manifest.take.sourceMappings.map((m) => m.takeOutFrame));
  const next = Math.max(Math.round(frames), minimum);
  if (next === manifest.take.durationFrames) return manifest;
  const copy = cloneJson(manifest);
  copy.take.durationFrames = next;
  // An object's keyframe track spans the whole take, so a longer take extends it.
  for (const t of copy.take.tracks) if (t.driver === "keyframes" && t.endFrame === manifest.take.durationFrames) t.endFrame = next;
  return copy;
}

/** Sets (adds or replaces) the object's key at a frame; the track spans the whole take. */
export function setKey(manifest: TakeManifest, objectId: string, frame: number, transform: Transform, interpolation: Keyframe["interpolation"] = "linear"): TakeManifest {
  const duration = manifest.take.durationFrames;
  if (duration <= 0 || frame < 0 || frame >= duration || !manifest.scene.objects.some((o) => o.id === objectId)) return manifest;
  const copy = cloneJson(manifest);
  const key: Keyframe = { frame: Math.round(frame), transform: cloneJson(transform), interpolation };
  const existing = copy.take.tracks.find((t) => t.driver === "keyframes" && t.target.kind === "object" && t.target.objectId === objectId) as KeyTrack | undefined;
  if (!existing) {
    // A new key track replaces any other driver for this object (one driver per target and interval).
    copy.take.tracks = copy.take.tracks.filter((t) => !(t.target.kind === "object" && t.target.objectId === objectId));
    copy.take.tracks.push({ id: newId("track"), target: { kind: "object", objectId }, startFrame: 0, endFrame: duration, driver: "keyframes", keyframes: [key] });
    return copy;
  }
  existing.keyframes = [...existing.keyframes.filter((k) => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame);
  return copy;
}

/** Removes the object's key at a frame; the last key removes the track and leaves the pose there as the base. */
export function removeKey(manifest: TakeManifest, objectId: string, frame: number): TakeManifest {
  const track = keyTrackOf(manifest, objectId);
  if (!track || !track.keyframes.some((k) => k.frame === frame)) return manifest;
  const copy = cloneJson(manifest);
  const t = copy.take.tracks.find((x) => x.id === track.id) as KeyTrack;
  t.keyframes = t.keyframes.filter((k) => k.frame !== frame);
  if (!t.keyframes.length) {
    copy.take.tracks = copy.take.tracks.filter((x) => x.id !== track.id);
    const object = copy.scene.objects.find((o) => o.id === objectId)!;
    object.transform = cloneJson(track.keyframes[0].transform);
  }
  return copy;
}
