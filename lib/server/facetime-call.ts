/**
 * Start a FaceTime capture from the web app (demo machine only).
 *
 * The call itself is the existing pipeline: lib/capture/call-http.mts runs the
 * Python capture agent and relays its frames into the project with the
 * requesting user's access token. A server-side access code (CALL_ACCESS_CODE)
 * gates it, because every call spends Chert, LiveKit and fal usage.
 *
 * With `sceneSplat`, the finished call's frames go to fal-ai/vggt-1b, the fused
 * cloud becomes a levelled, roughly room-sized splat, and a "Scene" object with
 * that splat is saved as a new revision of the project's active take.
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { newId, type Actor, type Observation, type Result, type SceneObject } from "@/lib/contracts";
import { err, ok } from "@/lib/contracts";
import { buildBoxGlb } from "@/lib/assets/glb";
import { loadProjectAsset, storeProjectAsset } from "@/lib/capture/assets";
import { createLiveFalQueue } from "@/lib/reconstruction/fal-live";
import { pointsFromGlb, pointsToS1Splat } from "@/lib/reconstruction/scene-splat";
import { serverBlobs } from "@/lib/reconstruction/server-blobs";
import { addObject } from "@/lib/editor/model";
import type { PostgresBackend } from "./postgres-backend";

export const CALL_SECONDS = 35;
const SCENE_MODEL = "fal-ai/vggt-1b";
const ROOM_EXTENT_M = 5;

/** Scene splat density: more points and finer voxels look sharper but take longer to build and load. */
export const SCENE_DETAIL = {
  light: { maxPoints: 150_000, voxelFraction: 1 / 350 },
  standard: { maxPoints: 300_000, voxelFraction: 1 / 500 },
  dense: { maxPoints: 600_000, voxelFraction: 1 / 750 },
} as const;
export type SceneDetail = keyof typeof SCENE_DETAIL;

export type CallState = { state: "idle" | "calling" | "building" | "done" | "failed"; message: string; projectId?: string; at: number };

const holder = globalThis as typeof globalThis & { __facetimeCall?: CallState };
const setState = (s: Omit<CallState, "at">) => (holder.__facetimeCall = { ...s, at: Date.now() });
export const callState = (): CallState => holder.__facetimeCall ?? { state: "idle", message: "", at: 0 };

/** Constant-time check of the server-side access code; false when none is configured. */
export function codeMatches(given: string): boolean {
  const expected = process.env.CALL_ACCESS_CODE ?? "";
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startCall(args: {
  backend: PostgresBackend;
  actor: NonNullable<Actor>;
  accessToken: string;
  projectId: string;
  origin: string;
  sceneSplat: boolean;
  detail?: SceneDetail;
}): Result<CallState> {
  const busy = callState();
  if (busy.state === "calling" || busy.state === "building") return err("RESOURCE_LIMIT", "a FaceTime capture is already running; wait for it to finish");
  const python = process.env.CAPTURE_PYTHON;
  const root = process.cwd();
  const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
  if (!python || !existsSync(resolve(root, python)) || !existsSync(tsx))
    return err("PROVIDER_UNAVAILABLE", "FaceTime capture runs only on the demo machine with the capture agent installed");
  const started = Date.now();
  const child = spawn(process.execPath, [tsx, "lib/capture/call-http.mts", "--project", args.projectId, "--seconds", String(CALL_SECONDS)], {
    cwd: root,
    env: { ...process.env, INGEST_API_URL: process.env.INGEST_API_URL || args.origin, INGEST_ACCESS_TOKEN: args.accessToken },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (e) => setState({ state: "failed", message: `Could not start the call: ${e.message}`, projectId: args.projectId }));
  child.on("exit", (code) => {
    if (code !== 0) return setState({ state: "failed", message: `The call ended with an error (exit ${code}). Frames received so far are in the project.`, projectId: args.projectId });
    if (!args.sceneSplat) return setState({ state: "done", message: "Call finished. Its frames are in Generate.", projectId: args.projectId });
    setState({ state: "building", message: "Call finished. Building the scene splat (a cold start can take a few minutes)…", projectId: args.projectId });
    void buildSceneFromCall(args.backend, args.actor, args.projectId, started, args.detail ?? "standard")
      .then((r) => setState(r.ok ? { state: "done", message: r.value, projectId: args.projectId } : { state: "failed", message: `Scene splat failed: ${r.error.message}`, projectId: args.projectId }))
      .catch((e) => setState({ state: "failed", message: `Scene splat failed: ${e instanceof Error ? e.message : String(e)}`, projectId: args.projectId }));
  });
  return ok(setState({ state: "calling", message: `Calling now. Answer FaceTime and slowly sweep the room for about ${CALL_SECONDS} seconds.`, projectId: args.projectId }));
}

/** Build the scene splat for one existing capture (e.g. an uploaded video) in the background. */
export function startSceneBuild(args: { backend: PostgresBackend; actor: NonNullable<Actor>; projectId: string; sourceId: string; detail?: SceneDetail }): Result<CallState> {
  const busy = callState();
  if (busy.state === "calling" || busy.state === "building") return err("RESOURCE_LIMIT", "a capture or scene build is already running; wait for it to finish");
  const state = setState({ state: "building", message: "Building the scene splat from this video (a cold start can take a few minutes)…", projectId: args.projectId });
  void (async () => {
    const listed = await args.backend.ingestion.listObservations(args.actor, args.projectId, args.sourceId);
    if (!listed.ok) return setState({ state: "failed", message: `Scene splat failed: ${listed.error.message}`, projectId: args.projectId });
    const frames = listed.value.filter((o) => o.mode === "evidence").sort((a, b) => a.sourceTimeUs - b.sourceTimeUs);
    const r = await buildSceneFromFrames(args.backend, args.actor, args.projectId, frames, args.detail ?? "standard");
    setState(r.ok ? { state: "done", message: r.value, projectId: args.projectId } : { state: "failed", message: `Scene splat failed: ${r.error.message}`, projectId: args.projectId });
  })().catch((e) => setState({ state: "failed", message: `Scene splat failed: ${e instanceof Error ? e.message : String(e)}`, projectId: args.projectId }));
  return ok(state);
}

/** Frames of the newest capture that started after `since` (the call just made). */
async function callFrames(backend: PostgresBackend, actor: NonNullable<Actor>, projectId: string, since: number): Promise<Observation[]> {
  const { rows } = await backend.pool.query<{ doc: unknown }>(
    `select o.doc from observations o join projects p on p.id = o.project_id
     where p.id = $1 and p.owner_id = $2 and o.source_id = (
       select source_id from observations where project_id = $1 and received_at >= $3 order by received_at desc limit 1)
     order by o.source_time_us`,
    [projectId, actor.userId, new Date(since - 5000)],
  );
  return rows.map((r) => r.doc as Observation);
}

async function waitFor(fal: ReturnType<typeof createLiveFalQueue>, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { requestId } = await fal.submit(SCENE_MODEL, input);
  const t = Date.now();
  for (;;) {
    const s = await fal.status(SCENE_MODEL, requestId);
    if (s.status === "COMPLETED") break;
    if (Date.now() - t > 600_000) throw new Error(`still running after 10 minutes (request ${requestId})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const out = (await fal.result(SCENE_MODEL, requestId)) as { data?: Record<string, unknown> } & Record<string, unknown>;
  return out.data ?? out;
}

export async function buildSceneFromCall(backend: PostgresBackend, actor: NonNullable<Actor>, projectId: string, since: number, detail: SceneDetail = "standard"): Promise<Result<string>> {
  return buildSceneFromFrames(backend, actor, projectId, await callFrames(backend, actor, projectId, since), detail);
}

async function buildSceneFromFrames(backend: PostgresBackend, actor: NonNullable<Actor>, projectId: string, frames: Observation[], detail: SceneDetail): Promise<Result<string>> {
  if (frames.length < 2) return err("NOT_FOUND", "the capture has fewer than two frames");
  const ply = await sceneSplatPly(backend, actor, projectId, frames, detail);
  if (!ply.ok) return ply;
  const deps = { assets: backend.assets, blobs: serverBlobs(backend, actor), actor };
  const splat = await storeProjectAsset(deps, projectId, ply.value, { kind: "splat", mimeType: "application/octet-stream", origin: "provider" });
  if (!splat.ok) return splat;
  const added = await addSceneObject(backend, actor, projectId, splat.value.id, frames);
  return added.ok ? ok(`Scene splat added to the take (${frames.length} frames). Reload the editor to see it.`) : added;
}

/** The levelled, roughly room-sized S1 splat for one capture's frames (paid VGGT call; nothing stored). */
export async function sceneSplatPly(backend: PostgresBackend, actor: NonNullable<Actor>, projectId: string, frames: Observation[], detail: SceneDetail = "standard"): Promise<Result<Uint8Array>> {
  const density = SCENE_DETAIL[detail];
  const deps = { assets: backend.assets, blobs: serverBlobs(backend, actor), actor };
  const fal = createLiveFalQueue();
  const { default: sharp } = await import("sharp");
  const urls: string[] = [];
  for (const [i, o] of frames.entries()) {
    const frame = await loadProjectAsset(deps, projectId, o.frame.assetId);
    if (!frame.ok) continue;
    // Call frames are portrait video inside black letterbox bars; crop them off first.
    const cropped = await sharp(Buffer.from(frame.value.bytes)).trim({ background: "#000000", threshold: 24 }).jpeg({ quality: 90 }).toBuffer();
    urls.push(await fal.upload(new Uint8Array(cropped), "image/jpeg", `scene-${i}.jpg`));
  }
  if (urls.length < 2) return err("NOT_FOUND", "the call's frames could not be read");
  const out = await waitFor(fal, { image_urls: urls, export_point_cloud: true, max_points: density.maxPoints, confidence_percentile: 35 });
  const cloudUrl = (out.point_cloud as { url?: string } | undefined)?.url;
  if (!cloudUrl) return err("PROVIDER_ERROR", "VGGT returned no point cloud");
  const glb = (await fal.download(cloudUrl)).bytes;
  const ply = pointsToS1Splat(pointsFromGlb(glb), {
    voxelFraction: density.voxelFraction,
    targetExtent: ROOM_EXTENT_M,
    levelByPlane: true,
  });
  return ok(ply);
}

async function addSceneObject(backend: PostgresBackend, actor: NonNullable<Actor>, projectId: string, splatAssetId: string, frames: Observation[]): Promise<Result<true>> {
  const project = await backend.projects.getProject(actor, projectId);
  if (!project.ok) return project;
  const head = await backend.projects.getRevision(actor, projectId, project.value.activeTakeId);
  if (!head.ok) return head;
  const deps = { assets: backend.assets, blobs: serverBlobs(backend, actor), actor };
  // Objects need a mesh; the scene carries a tiny placeholder so its splat has an object to ride on.
  const half = 0.01;
  const marker = buildBoxGlb({ size: [half * 2, half * 2, half * 2], color: [0.8, 0.8, 0.8, 1], name: "scene-marker" });
  const mesh = await storeProjectAsset(deps, projectId, marker, { kind: "mesh", mimeType: "model/gltf-binary", origin: "editor" });
  if (!mesh.ok) return mesh;
  const object: SceneObject = {
    id: newId("object"),
    name: "Scene (splat)",
    geometry: {
      assetId: mesh.value.id,
      geometryRevision: 1,
      originalAssetId: null,
      normalization: { sourceUnits: "m", sourceUpAxis: "+Y", scaleApplied: 1, nodeTransformsBaked: false },
      localBounds: { min: [-half, -half, -half], max: [half, half, half] },
    },
    material: { mode: "embedded" },
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true,
    dimensionsStatus: "estimated",
    provenance: {
      kind: "generated",
      sourceIds: [...new Set(frames.map((f) => f.sourceId))],
      observationIds: frames.slice(0, 50).map((f) => f.id),
      jobId: null,
      provider: SCENE_MODEL,
      note: `Scene splat from ${frames.length} call frames; levelled from camera poses, sized to about ${ROOM_EXTENT_M} m (estimate)`,
    },
    splat: { assetId: splatAssetId, enabled: true, validForGeometryRevision: 1 },
    collider: null,
    physics: null,
  };
  const saved = await backend.projects.saveRevision(actor, {
    projectId,
    takeId: project.value.activeTakeId,
    expectedRevision: head.value.number,
    manifest: addObject(head.value.manifest, object),
    idempotencyKey: newId("job").replace("job_", "scene_"),
    message: "Scene splat from FaceTime call",
  });
  return saved.ok ? ok(true) : saved;
}
