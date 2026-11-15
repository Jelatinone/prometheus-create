/**
 * Client-side "create a project from the labeled axis-box fixture" flow,
 * written against the platform HTTP API only:
 *
 *   1. POST /api/projects                 revision 1, empty scene
 *   2. POST /api/assets/upload-url        signed direct-upload target
 *   3. PUT  <signed storage URL>          bytes go straight to storage
 *   4. POST /api/assets                   metadata only
 *   5. POST .../takes/<take>/revisions    revision 2 with the box
 *
 * Runs in the browser (and in tests with an injected fetch/uploader).
 */
import fixtureManifest from "@/fixtures/contracts/take-manifest.original.json";
import { newId } from "@/lib/contracts/common";
import { sha256 } from "@/lib/contracts/canonical";
import type { Asset } from "@/lib/contracts/asset";
import type { CreateProjectResponse, SaveRevisionResponse, TakeManifest } from "@/lib/contracts/revision";

export const FIXTURE_GLB_URL = "/fixtures/axis-box.glb";
export const FIXTURE_TITLE = "Axis box (fixture)";

export interface ApiCall {
  step: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface SignedUploadTarget {
  bucket: string;
  path: string;
  token: string;
  storageKey: string;
}

export interface FixtureFlowDeps {
  fetch: typeof fetch;
  /** PUT bytes to a signed upload target (supabase-js uploadToSignedUrl in the browser). */
  upload(target: SignedUploadTarget, bytes: Uint8Array, contentType: string): Promise<void>;
  onCall?(call: ApiCall): void;
}

export interface FixtureFlowResult {
  projectId: string;
  takeId: string;
  assetId: string;
  created: CreateProjectResponse;
  saved: SaveRevisionResponse;
  calls: ApiCall[];
}

export class ApiError extends Error {
  constructor(readonly call: ApiCall) {
    super(`${call.step}: HTTP ${call.status} ${JSON.stringify(call.body)}`);
  }
}

const idempotencyKey = () => newId("revision").replace("rev_", "key-");

/** The fixture manifest retargeted to fresh project/take/asset IDs. */
export function retargetedFixture(ids: { projectId: string; takeId: string; assetId: string }): TakeManifest {
  const text = JSON.stringify(fixtureManifest)
    .replaceAll("prj_fixture_demo", ids.projectId)
    .replaceAll("tk_fixture_original", ids.takeId)
    .replaceAll("ast_fixture_axis_box", ids.assetId);
  return JSON.parse(text) as TakeManifest;
}

export async function createFixtureProject(deps: FixtureFlowDeps, glb: Uint8Array): Promise<FixtureFlowResult> {
  const calls: ApiCall[] = [];
  const call = async <T>(step: string, method: string, path: string, body: unknown, expect: number[]): Promise<T> => {
    const response = await deps.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const parsed = (await response.json().catch(() => null)) as unknown;
    const record: ApiCall = { step, method, path, status: response.status, body: parsed };
    calls.push(record);
    deps.onCall?.(record);
    if (!expect.includes(response.status)) throw new ApiError(record);
    return parsed as T;
  };

  const projectId = newId("project");
  const takeId = newId("take");
  const assetId = newId("asset");
  const full = retargetedFixture({ projectId, takeId, assetId });
  const empty: TakeManifest = { ...full, scene: { ...full.scene, objects: [] } };

  const created = await call<CreateProjectResponse>(
    "create project (revision 1, empty scene)",
    "POST",
    "/api/projects",
    { projectId, title: FIXTURE_TITLE, initialManifest: empty, idempotencyKey: idempotencyKey() },
    [201],
  );

  const contentHash = await sha256(glb);
  const mimeType = "model/gltf-binary";
  const signed = await call<{ upload: SignedUploadTarget }>(
    "request signed upload URL",
    "POST",
    "/api/assets/upload-url",
    { projectId, assetId, kind: "mesh", mimeType, byteSize: glb.byteLength },
    [201],
  );
  await deps.upload(signed.upload, glb, mimeType);
  calls.push({ step: "PUT bytes to signed storage URL", method: "PUT", path: "(storage)", status: 200, body: null });
  deps.onCall?.(calls.at(-1)!);

  const asset: Asset = {
    schemaVersion: 1,
    id: assetId,
    projectId,
    kind: "mesh",
    mimeType,
    byteSize: glb.byteLength,
    contentHash,
    storageKey: signed.upload.storageKey,
    origin: "fixture",
    createdAt: new Date().toISOString(),
  };
  await call<Asset>("record asset metadata", "POST", "/api/assets", asset, [201]);

  const saved = await call<SaveRevisionResponse>(
    "save revision 2 (axis box in scene)",
    "POST",
    `/api/projects/${projectId}/takes/${takeId}/revisions`,
    { projectId, takeId, expectedRevision: 1, manifest: full, idempotencyKey: idempotencyKey(), message: "add axis box fixture" },
    [201],
  );
  return { projectId, takeId, assetId, created, saved, calls };
}
