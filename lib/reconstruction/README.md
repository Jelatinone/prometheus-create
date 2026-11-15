# lib/reconstruction: notes for agents

Image-to-3D jobs against `fal-ai/sam-3/image` (masks) and `fal-ai/sam-3/3d-objects` (mesh + Gaussian splat), driven through the `JobStore` port (contract CT-002). It is owned by Track A (HK-011); history lives in `docs/changes/HK-002.md` and `docs/changes/HK-011.md`.

## Files

| File | What it does |
| --- | --- |
| `runner.ts` | Job lifecycle: `runSegmentation`, `runReconstruction`, `resumeReconstruction`, `backfillSplat`, `splatBackfillJobId`, `previewMesh` |
| `http.ts` | `POST /api/reconstruction` command (actions `segment`, `reconstruct`, `poll`, `attach_splat`, `mesh_preview`); one provider step per request |
| `fal-queue.ts` | Provider seam (`FalQueue`), output types, `pickGlb`/`pickBundle`/`pickMasks`, listed prices |
| `fal-live.ts` | Live `FalQueue` (server only; key from `FAL_KEY`/`FAL_API_KEY`) |
| `glb-normalize.ts` | Canonical mesh space via one added root node; returns `rootTransform` |
| `splat.ts` | Provider splat → **S1** splat (see below) |
| `placement.ts` | Provider pose → scene placement per object; `levelPlacements` for a frame's objects |
| `mesh-simplify.ts` | `simplifyGlb`: attribute-aware triangle simplification (meshoptimizer); keeps nodes, materials, images |
| `mesh-preview.ts` | `ensureMeshPreview` / `findMeshPreview`: the cached preview asset (server) |
| `mesh-preview-id.ts` | `meshPreviewAssetId`, `MESH_PREVIEW_TRIANGLES`: client-safe lookup of a mesh's preview |
| `server-blobs.ts` | Private storage adapter for routes |
| `live-run.ts` | CLI for a live run with a spend estimate |

## Job lifecycle (and the cost rules)

`queued → submitted (providerRequestId stored before the first poll) → running → succeeded | failed`. `succeeded` is terminal; its output never changes.

- **Never pay twice.** A job with a request ID is never submitted again; it is resumed by polling that ID. A `queued` job without a request ID is an error for a person to reconcile, not a resubmission.
- **Free versus paid provider calls.** `submit` is the paid call: $0.02 for a 3D job, $0.005 for a mask (fal listing, 2026-11-14). `status`, `result` and file downloads of an existing request are not new inference.
- **Approval.** Get Cody's approval before any new `submit`, report the spend, and never retry an exhausted-balance 403. The total budget is $10.
- **Owned copies.** Provider URLs are temporary. Accepted outputs are copied to private storage before success is recorded. Asset IDs are content-addressed: `projectAssetId(project, kind, sha256)`.

## Splats (PLAN v4 seams S1/S2/S5)

- **Source.** Use `artifacts_zip` → `object_NN/splat.ply`. The provider puts the object in a **Z-up version of the GLB frame**: GLB (x, y, z) = splat (x, z, −y). This was measured in HK-011 CP-007 on the round table and the fal sample car. The top-level `gaussian_splat` is posed into the **camera** frame. Do not store it as the object's splat.
- **S1 form.** A binary 3DGS PLY with 14 floats (`x y z f_dc_0..2 opacity scale_0..2 rot_0..3`; `rot_0` is w). It is in the same object-local space as the normalized mesh, so viewers apply no extra normalization. Normals and invisible Gaussians (α < 1/255) are dropped. The faintest Gaussians are pruned only when the file would exceed the 50 MB object cap (the Supabase bucket limit; do not raise it); the count is reported in `splatNote`.
- **Outcome.** `ReconstructionOutcome.splatAsset`, and `job.output.splatAssetId`. A missing or unusable splat never fails the job: it is a mesh-only success with a `splatNote`.
- **Old jobs (S5).** For jobs that succeeded before splats were stored, `attach_splat` / `backfillSplat` creates a backfill job with ID `splatBackfillJobId(original)`. That job adopts the original request ID **without submitting** and finishes normally. Its `meshAsset.id` equals the original's `meshAssetId`, which proves the splat is aligned with that mesh. Repeat the call until the job settles; repeats are idempotent.
- **Honesty.** Splats are inferred appearance, hidden surfaces included. Never label them measured or raw depth.

## Placement and multiple objects (HK-011 CP-009)

- **Pose.** `output.metadata[i]` gives each object's pose in the frame's camera. It is measured, not taken from the docs:
  - The rotation is a quaternion in **[w, x, y, z]** order applied as its **transpose**: `posed = s·R(q)ᵀ·p_splat + t`. The docs list [x, y, z, w], which does not fit.
  - The camera frame is PyTorch3D-style (+X left, +Y up, +Z forward). The canonical scene frame is a 180° turn about Y.
  - On the round table, the placement reproduces the provider's posed splat to 0.45 mm mean.
- **Kept on resume.** The pose JSON is stored as `rawAssetIds[1]` (`provider_raw`, `application/json`); `[0]` is always the GLB. `outcome.placement` is a transform for the normalized mesh / S1 space, `{ position, rotation, scale, up }`, plus `placementNote` when it is missing. Jobs finished before CP-009 have no stored pose.
- **Decision: 2–3 objects means one single-mask job per object.** A job output has one `meshAssetId`, so a multi-mask job cannot be represented without a contract change. Every child job on the same frame is posed in that frame's camera, so `levelPlacements([...])` lays them out together.
- **Segmentation.** It asks for every matching instance (`return_multiple_masks`, up to `SEGMENT_MAX_MASKS` = 3, with scores), so one prompt can yield the 2–3 masks.
- **Measured (paid live test, 2026-11-15, $0.05).** Two chairs of the same model from one frame, as two separate jobs:
  - Scale and spacing are consistent: 0.56×0.90×0.58 m vs 0.57×0.96×0.66 m, and they sit 1.6 m apart.
  - Orientation estimates drift by **13.5°**. With shared leveling, each object then stays tilted 6.7° and the bases are 0.18 m apart.
- **Default layout.** Hence the default `levelPlacements(list)` ("each" mode):
  - Positions come from the shared leveling.
  - Each object is then stood upright on its own, with its base on y = 0.
  - `"shared"` keeps each object's provider orientation and real elevation differences (e.g. tiers).
- **Contract change not needed.** A single multi-mask job would share one pose estimate, but it would need a contract change. Propose it only if manual tests show the "each" layout is wrong.
- **Scale.** `placement.scale` is the provider's metric estimate: the round table is 0.576 m wide instead of the unit-normalized 1 m. It is still an estimate; keep `dimensionsStatus: "estimated"`.

## Mesh preview (HK-011 CP-010)

Provider meshes are dense: the round table is 1,047,216 triangles (21 MB), and the chairs are 504,562 and 435,442. Every succeeded reconstruction above **100,000 triangles** also gets a **cached simplified preview**. The full mesh is never modified: it stays `geometry.assetId` and `job.output.meshAssetId`, and it is what export and later editing use.

- **Where it is.** The preview is a separate `mesh` asset (`model/gltf-binary`, origin `provider`). Its ID is `meshPreviewAssetId(projectId, meshAssetId)`, derived from the source mesh's ID and the recipe `mesh-preview:v1:100000`; its `contentHash` is still the hash of its bytes. Anyone holding `geometry.assetId` can find it without a contract change. **Editor use (Track B / CP-016):** compute the ID with `lib/reconstruction/mesh-preview-id.ts` (client-safe), download it through the private asset route, and fall back to the full mesh on 404. `outcome.previewMeshAsset` / `previewNote` carry the same asset right after a job.
- **When it is made.** The finish makes it best-effort **after** the job is recorded `succeeded`, so a slow or failed simplification never delays or fails a job. A resumed job only looks it up and never recomputes. `POST /api/reconstruction` `mesh_preview` (a succeeded reconstruction's `jobId`) creates a missing one. It uses local CPU only, never a provider call, and it is idempotent. The round table and both chairs in the round-table project have one (CP-010 evidence).
- **What it keeps.** The node tree (including the normalization root), materials, textures and embedded images stay byte-identical, so the preview shares the mesh's object space and splat alignment. Only indexed triangle primitives with `POSITION`/`NORMAL`/`COLOR_0`/`TEXCOORD_0` are rewritten. Borders are locked, colours weigh 1, and the relative error limit is 1e-3. Animated, skinned, morphed, instanced, non-indexed or required-extension meshes are refused with a note, and nothing is guessed.
- **Why 100k.** The visual comparison in HK-011 CP-010 evidence used the editor's lights, three views and the full mesh against 250k/100k/50k. At the editor framing, 100k differs from full by under 0.1 of 255 on average, with ≤ 0.08% of pixels off by more than 16. A close-up shows slight rim faceting. Bounds move ≤ 0.11 mm.
- **Cost.** About 2–3 s of CPU for 1M triangles plus a ~1.4 MB upload. With storage round trips, `mesh_preview` took 6–9 s live. Bump `MESH_PREVIEW_RECIPE` if the simplifier's output changes.

## Timeouts: what happens and why it converges

The finishing step (the poll that sees `COMPLETED`) downloads the bundle (~62 MB for the round table: mesh, splat and pose). It falls back to `model_glb` (~21 MB) when the bundle has no usable mesh. It then uploads raw GLB, normalized mesh and splat (≈ 21 + 21 + 47 MB). On a slow link or a serverless limit, that single request can exceed the platform timeout.

- **State stays safe.** A job only becomes `succeeded` after every output is stored. A cut-off finish leaves it `submitted`/`running` with its request ID, so nothing is lost or paid twice.
- **Retries converge (HK-011 CP-008).** `storeProjectAsset` skips the upload when the catalog already records that exact content. The catalog row is written only after the bytes are stored, so the row proves the blob exists. Each retry therefore only does the uploads that had not finished. Downloads still repeat per attempt.
- **Locks.** `app/api/reconstruction/route.ts` takes a Postgres advisory lock per job ID. A concurrent request gets `PROVIDER_UNAVAILABLE` ("processing in another request; resume shortly"). That error is retryable, not a failure.
- **Client (Track B, `components/editor/ReconstructPanel.tsx`).** Today any non-ok response stops the loop and shows the error; pressing Generate again resumes, because the job IDs are remembered. Recommended: auto-retry `PROVIDER_UNAVAILABLE` and network/5xx errors with backoff for the same job ID, and treat a `failed` job as final.
- **`maxDuration`.** The route sets `export const maxDuration = 60`. Next.js treats this as a hint to the deployment platform (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`); `next dev` and `next start` do not enforce it. Raise it only together with an approved hosting decision and that platform's documented limit.
- **One download (CP-009).** When the bundle has `object_00/mesh.glb`, which is byte-identical to `model_glb` in both observed outputs, the finish uses it and skips the separate ~21 MB `model_glb` download. That leaves one ~62 MB download per attempt; `model_glb` stays the fallback.
- **Further options if finishing still times out**, not implemented:
  - Move the bundle work to `after()`/background processing.
  - Use ranged reads of only the needed zip entries.
- **Security notes for the final pass.**
  - Routes authorize by project ownership before any provider or storage work. A foreign user gets 404 (live-checked), and asset downloads are short-lived signed URLs (300 s).
  - `attach_splat` never submits a paid job.
  - `mesh_preview` is owner-only and never calls the provider. It does spend ~3 s of server CPU per new preview (then it is cached); consider rate limits there.
  - Provider URLs are not stored in manifests.

## Local evidence scripts (ignored `.verify/`)

- `.verify/hk011/s1-check.mts <objects_bundle.zip> [out.ply]` runs the same functions on a saved provider bundle. It prints the bounds, nearest-vertex distance and quaternion-convention checks, without calling fal.
- `.verify/hk011/simplify-check.mts [glb] [name]` simplifies a local GLB to 250k/100k/50k. `.verify/hk011/preview/compare.html` (served by `preview/serve.mjs`, rendered with headless Chrome and SwiftShader) gives the side-by-side images and pixel differences. `.verify/hk011/preview-live.mts ensure|readback` runs `previewMesh` on the live round-table project with every fal method throwing.
- Run `.mts` scripts with `npx tsx` and import leaf modules (see AGENTS.md). On Windows, start Node from an uppercase `C:` path.
