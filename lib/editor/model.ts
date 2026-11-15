/**
 * Pure editor model (HK-004): manifest edits, undo/redo history and transform
 * helpers. No three.js scene or DOM here, so every rule is unit-testable.
 *
 * Edits return a new manifest and never mutate their input. Selection,
 * orbiting and playback are view state and never pass through these functions,
 * so they can never create a revision.
 */
import { Euler, Quaternion } from "three";
import { canonicalJson, cloneJson } from "@/lib/contracts/canonical";
import type { Quat, Transform, Vec3 } from "@/lib/contracts/common";
import type { TakeManifest } from "@/lib/contracts/revision";
import type { SceneObject } from "@/lib/contracts/scene";

export function findObject(manifest: TakeManifest, objectId: string | null): SceneObject | null {
  return manifest.scene.objects.find((o) => o.id === objectId) ?? null;
}

function editObject(manifest: TakeManifest, objectId: string, edit: (o: SceneObject) => void): TakeManifest {
  if (!findObject(manifest, objectId)) return manifest;
  const next = cloneJson(manifest);
  edit(next.scene.objects.find((o) => o.id === objectId)!);
  return next;
}

export function setObjectTransform(manifest: TakeManifest, objectId: string, transform: Transform): TakeManifest {
  return editObject(manifest, objectId, (o) => {
    o.transform = cloneJson(transform);
  });
}

export function renameObject(manifest: TakeManifest, objectId: string, name: string): TakeManifest {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return manifest;
  return editObject(manifest, objectId, (o) => {
    o.name = trimmed;
  });
}

export function setObjectVisible(manifest: TakeManifest, objectId: string, visible: boolean): TakeManifest {
  return editObject(manifest, objectId, (o) => {
    o.visible = visible;
  });
}

export function addObject(manifest: TakeManifest, object: SceneObject): TakeManifest {
  const next = cloneJson(manifest);
  next.scene.objects.push(cloneJson(object));
  return next;
}

/** Removes the object and anything that would dangle without it (tracks, scale reference). */
export function removeObject(manifest: TakeManifest, objectId: string): TakeManifest {
  if (!findObject(manifest, objectId)) return manifest;
  const next = cloneJson(manifest);
  next.scene.objects = next.scene.objects.filter((o) => o.id !== objectId);
  next.take.tracks = next.take.tracks.filter((t) => t.target.kind !== "object" || t.target.objectId !== objectId);
  if (next.scene.scale.reference?.objectId === objectId) next.scene.scale = { status: "estimated", reference: null };
  for (const o of next.scene.objects)
    if (o.physics?.joint?.connectedObjectId === objectId) o.physics.joint.connectedObjectId = null;
  return next;
}

/** Same geometry asset, new id, offset so the copy is visible. */
export function duplicateObject(manifest: TakeManifest, objectId: string, newObjectId: string): TakeManifest {
  const source = findObject(manifest, objectId);
  if (!source) return manifest;
  const copy = cloneJson(source);
  copy.id = newObjectId;
  copy.name = `${source.name} copy`.slice(0, 80);
  const width = source.geometry.localBounds.max[0] - source.geometry.localBounds.min[0];
  copy.transform.position = [copy.transform.position[0] + width * source.transform.scale[0] * 1.2, copy.transform.position[1], copy.transform.position[2]];
  copy.provenance = { ...copy.provenance, kind: "user", note: `Duplicated from ${source.id}` };
  copy.physics = null;
  return addObject(manifest, copy);
}

// ---------------------------------------------------------------------------
// Transform helpers (canonical: meters, +Y up, quaternion [x, y, z, w])
// ---------------------------------------------------------------------------

const DEG = 180 / Math.PI;

/** XYZ Euler angles in degrees, for the inspector. */
export function quatToEulerDeg(q: Quat): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]).normalize(), "XYZ");
  return [e.x * DEG, e.y * DEG, e.z * DEG].map(cleanNumber) as Vec3;
}

export function eulerDegToQuat(deg: Vec3): Quat {
  const q = new Quaternion().setFromEuler(new Euler(deg[0] / DEG, deg[1] / DEG, deg[2] / DEG, "XYZ"));
  return [q.x, q.y, q.z, q.w].map(cleanNumber) as Quat;
}

/** Uniform scale keeps the ratio between axes; the factor must be positive and finite. */
export function withUniformScale(transform: Transform, factor: number): Transform | null {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return { ...transform, scale: [factor, factor, factor] };
}

/** The uniform factor the inspector shows (the mean of the axes; equal for uniform scale). */
export function uniformFactor(transform: Transform): number {
  return cleanNumber((transform.scale[0] + transform.scale[1] + transform.scale[2]) / 3);
}

/** Trims float noise from gizmo math (1e-9 m is far below anything visible). */
export function cleanNumber(n: number): number {
  const r = Math.round(n * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

export function cleanTransform(t: Transform): Transform {
  return {
    position: t.position.map(cleanNumber) as Vec3,
    rotation: t.rotation.map(cleanNumber) as Quat,
    scale: t.scale.map((s) => Math.max(cleanNumber(s), 1e-6)) as Vec3,
  };
}

export function sameManifest(a: TakeManifest, b: TakeManifest): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface History {
  past: TakeManifest[];
  present: TakeManifest;
  future: TakeManifest[];
}

const HISTORY_LIMIT = 100;

export function startHistory(manifest: TakeManifest): History {
  return { past: [], present: manifest, future: [] };
}

/** Records an edit; a no-op edit (identical manifest) records nothing. */
export function commit(history: History, next: TakeManifest): History {
  if (next === history.present || sameManifest(next, history.present)) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}
