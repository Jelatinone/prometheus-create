# lib/reconstruction: notes for agents

Image-to-3D jobs against `fal-ai/sam-3/image` (masks) and `fal-ai/sam-3/3d-objects` (mesh + Gaussian splat), driven through the `JobStore` port (contract CT-002). It is owned by Track A (HK-011); history lives in `docs/changes/HK-002.md` and `docs/changes/HK-011.md`.

## Files

| File | What it does |
| --- | --- |
| `runner.ts` | Job lifecycle: `runSegmentation`, `runReconstruction`, `resumeReconstruction`, `backfillSplat`, `splatBackfillJobId` |
| `http.ts` | `POST /api/reconstruction` command (actions `segment`, `reconstruct`, `poll`, `attach_splat`); one provider step per request |
| `fal-queue.ts` | Provider seam (`FalQueue`), output types, `pickGlb`/`pickBundle`/`pickMasks`, listed prices |
| `fal-live.ts` | Live `FalQueue` (server only; key from `FAL_KEY`/`FAL_API_KEY`) |
| `glb-normalize.ts` | Canonical mesh space via one added root node; returns `rootTransform` |
| `splat.ts` | Provider splat → **S1** splat (see below) |
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

## Timeouts: what happens and why it converges

The finishing step (the poll that sees `COMPLETED`) downloads the GLB (~21 MB for the round table) and the bundle (~62 MB; it repeats the mesh). It then uploads raw GLB, normalized mesh and splat (≈ 21 + 21 + 47 MB). On a slow link or a serverless limit, that single request can exceed the platform timeout.

- **State stays safe.** A job only becomes `succeeded` after every output is stored. A cut-off finish leaves it `submitted`/`running` with its request ID, so nothing is lost or paid twice.
- **Retries converge (HK-011 CP-008).** `storeProjectAsset` skips the upload when the catalog already records that exact content. The catalog row is written only after the bytes are stored, so the row proves the blob exists. Each retry therefore only does the uploads that had not finished. Downloads still repeat per attempt.
- **Locks.** `app/api/reconstruction/route.ts` takes a Postgres advisory lock per job ID. A concurrent request gets `PROVIDER_UNAVAILABLE` ("processing in another request; resume shortly"). That error is retryable, not a failure.
- **Client (Track B, `components/editor/ReconstructPanel.tsx`).** Today any non-ok response stops the loop and shows the error; pressing Generate again resumes, because the job IDs are remembered. Recommended: auto-retry `PROVIDER_UNAVAILABLE` and network/5xx errors with backoff for the same job ID, and treat a `failed` job as final.
- **`maxDuration`.** The route sets `export const maxDuration = 60`. Next.js treats this as a hint to the deployment platform (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`); `next dev` and `next start` do not enforce it. Raise it only together with an approved hosting decision and that platform's documented limit.
- **Further options if finishing still times out**, none implemented:
  - Take the mesh from the bundle's `object_NN/mesh.glb` (byte-identical to `model_glb` in both observed outputs) to drop one download.
  - Move the bundle work to `after()`/background processing.
  - Stream the zip instead of buffering it.

## Local evidence scripts (ignored `.verify/`)

- `.verify/hk011/s1-check.mts <objects_bundle.zip> [out.ply]` runs the same functions on a saved provider bundle. It prints the bounds, nearest-vertex distance and quaternion-convention checks, without calling fal.
- Run `.mts` scripts with `npx tsx` and import leaf modules (see AGENTS.md). On Windows, start Node from an uppercase `C:` path.
