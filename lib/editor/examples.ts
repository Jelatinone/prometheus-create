/**
 * Example projects offered from the saves page's Example menu. Each one is
 * created as an ordinary private project through the ports (create, upload
 * asset, save revision 2), exactly like an import.
 */
import { storeProjectAsset } from "@/lib/capture/assets";
import type { BlobStore } from "@/lib/capture/blob-store";
import { newId, ok, type Result } from "@/lib/contracts/common";
import type { Actor, AssetCatalog, ProjectRepository } from "@/lib/contracts/ports";
import { FIXTURE_GLB_URL, FIXTURE_TITLE, retargetedFixture } from "@/lib/platform/fixture-project";

export interface ExampleProject {
  id: string;
  name: string;
  note: string;
}

export const EXAMPLES: ExampleProject[] = [
  { id: "axis-box", name: FIXTURE_TITLE, note: "One labelled 0.4 × 0.9 × 0.2 m box; checks scale, move and fork" },
];

export interface ExampleDeps {
  projects: ProjectRepository;
  assets: AssetCatalog;
  blobs: BlobStore;
  actor: Actor;
  fetch?: typeof fetch;
}

const key = () => `example_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;

export async function createExample(deps: ExampleDeps, example: ExampleProject): Promise<Result<{ projectId: string }>> {
  const projectId = newId("project");
  const takeId = newId("take");
  const empty = retargetedFixture({ projectId, takeId, assetId: newId("asset") });
  empty.scene.objects = [];
  const created = await deps.projects.createProject(deps.actor, { projectId, title: example.name, initialManifest: empty, idempotencyKey: key() });
  if (!created.ok) return created;

  const response = await (deps.fetch ?? fetch)(FIXTURE_GLB_URL);
  const glb = new Uint8Array(await response.arrayBuffer());
  const asset = await storeProjectAsset({ assets: deps.assets, blobs: deps.blobs, actor: deps.actor }, projectId, glb, {
    kind: "mesh",
    mimeType: "model/gltf-binary",
    origin: "fixture",
  });
  if (!asset.ok) return asset;

  const saved = await deps.projects.saveRevision(deps.actor, {
    projectId,
    takeId,
    expectedRevision: 1,
    manifest: retargetedFixture({ projectId, takeId, assetId: asset.value.id }),
    idempotencyKey: key(),
    message: `Example: ${example.name}`,
  });
  if (!saved.ok) return saved;
  return ok({ projectId });
}
