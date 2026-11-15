# prometheus-create

Capture a scene, make its objects editable, and create another take. Hackathon build for HackUTA 2026; product intent, contracts, and gates live in [PLAN.md](PLAN.md).

**What works today:**

- Sign in with an emailed one-time code.
- A save viewer (`/projects`) lists your projects with a live 3D preview. From there you can create, import or download a project as a `.zip`.
- Opening a project slides the save viewer away to reveal the editor. In the editor you can:
  - select, move, rotate and uniformly scale meshes, with undo;
  - edit position, rotation and scale numerically;
  - import a GLB;
  - fork a take and save revisions to the cloud (a stale save is refused, never overwritten);
  - export PNG and GLB;
  - capture photos and camera frames into the project.

**Not wired into the app yet:**

- **Reconstruction.** Mesh from a photo (fal SAM 3D) runs as a CLI proof only.
- **FaceTime capture through Chert.** It is blocked on Chert's recipient verification.

## 1. Install

Requires Node.js 22.18 or later.

```bash
git submodule update --init --recursive
```

```bash
npm ci
```

```bash
npm run skills:check
```

Or run `npm run lane:setup` for all three. On Windows, confirm `node_modules/@rolldown/binding-win32-x64-msvc` exists after installing (npm/cli#4828 can prune it; `npm ci` restores it).

## 2. Configure `.env.local`

Create `.env.local` in the project root. It is git-ignored; never commit it. Values come from the project's Supabase and TigerData dashboards.

| Variable | Needed for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | sign-in and browser storage uploads |
| `SUPABASE_SECRET_KEY` | server-side session checks and storage administration |
| `SUPABASE_STORAGE_BUCKET` | private asset bucket (default `project-assets`) |
| `DATABASE_URL`, `DATABASE_CA_CERT` | TigerData Postgres (projects, takes, revisions, assets) |
| `TEST_DATABASE_URL` | live platform tests only; must be a different database service |
| `FAL_API_KEY` (or `FAL_KEY`) | the reconstruction CLI only (paid) |
| `CHERT_API_KEY`, `CHERT_PROJECT_ID`, `CHERT_LINE_ID`, `CHERT_TEST_DESTINATION`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the Python capture agent only |

Once per database and bucket, create the schema and the private bucket:

```bash
npm run db:migrate
```

```bash
npm run db:storage
```

## 3. Run

```bash
npm run dev
```

Open <http://localhost:3000>; it starts at sign-in. Enter your email and the one-time code you receive, and you land on your saves. The account button (top right on every screen) has **Sign out**.

- **Saves:**
  - **New** creates an empty project.
  - **Example** creates the labelled axis-box fixture project.
  - **Import .zip** restores a downloaded project as a new project.
  - **Download (.zip)** saves a project as `project.json` (every take's latest revision) plus `assets/`.
  - Select a row to preview it. Drag the preview to orbit. **Open** (or double-click) opens the editor.
- **Editor:**
  - Tools are **V** select, **W** move, **E** rotate, **R** scale and **F** frame.
  - **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo, **Ctrl+S** saves, **Ctrl+D** duplicates and **Del** deletes.
  - **Fork take** copies the saved revision into a new take. The take menu switches between takes.
  - The camera icon opens the upload, phone camera and video panel.
  - The folder icon (top left) slides the save viewer back.
  - The tools sit in the bottom toolbar; with an object selected it also shows hide, duplicate and delete.
- **Capture lab** (`/api/capture/lab`, development only): the capture panel on an in-memory backend, with no sign-in.

Live camera capture needs HTTPS or `localhost`. A phone reaching the dev server over LAN HTTP can still use **Take photo**.

### Optional: reconstruction CLI (paid)

Runs one real photo through fal (`sam-3/image` mask, then `sam-3/3d-objects`) and writes a validated, normalized GLB to `.verify/hk002-live/`. It prints its estimated spend: about $0.025 per run at listed prices.

```bash
npx tsx lib/reconstruction/live-run.ts --image photo.jpg --prompt chair
```

Import the resulting `normalized.glb` into a project with **Import GLB**.

### Optional: Chert / LiveKit capture agent (Python)

See [services/capture-agent/README.md](services/capture-agent/README.md). Outbound FaceTime calls currently fail with `recipient_not_verified`; see `docs/changes/HK-002.md`.

## Verify

```bash
npm run verify
```

This checks both agents' skill entrypoints, then runs typecheck, lint, unit and conformance tests, and a production build. It prints a pass/fail evidence table, saved to `.verify/report.md`. On a lane branch it first checks that only the lane's owned paths changed. Add `-- --quick` to skip the build. Live platform tests run only when `TEST_DATABASE_URL` and the Supabase keys are set.

Check a file by hand against the contracts:

```bash
npm run validate -- auto fixtures/contracts/take-manifest.original.json
```

- `npm run validate -- list` names every contract.
- `npm run validate -- <contract> <file.json>` checks any JSON: a saved manifest, an export manifest, or a capture-agent payload.
- `npm run validate -- glb <file.glb>` prints a mesh's dimensions, triangle count, and warnings.

## Layout

| Path | What |
| --- | --- |
| `app/projects/`, `components/editor/` | Save viewer (`SavesPage`), editor shell (`Editor`, `Inspector`) and the `Studio` that slides between them |
| `lib/editor/`, `lib/scene/` | Pure editor model, history and take sessions; project `.zip` archive; three.js viewport and exports |
| `app/api/`, `lib/server/`, `db/` | Platform API (projects, takes, revisions, assets, ingestion, jobs), Supabase auth, TigerData Postgres backend, migrations |
| `lib/platform/` | Browser client: `HttpBackend`, `PlatformBlobStore` (signed uploads), fixture project flow |
| `lib/capture/`, `components/capture/` | Upload, phone camera and video-frame capture into the ingestion contract |
| `lib/reconstruction/` | fal SAM 3D adapter, GLB normalization, live CLI |
| `services/capture-agent/` | Python Chert/LiveKit agent that turns caller frames into ingestion envelopes |
| `lib/contracts/` | Shared zod contracts (scene, source, ingestion, revision, export, proposals), ports, generated JSON Schema |
| `lib/reference/` | In-memory reference backend implementing the ports |
| `lib/assets/` | GLB inspection and fixture writer |
| `fixtures/` | Golden and invalid contract fixtures; `public/fixtures/axis-box.glb` |
| `tests/` | Contract, conformance, platform, capture, reconstruction, editor, and lane-ownership tests |
| `lanes.json`, `docs/LANES.md` | Parallel lane ownership and protocol |
| `docs/changes/` | One task note per task (assignment, plan, evidence) |
| `toolkit/` | Pinned hackathon-toolkit submodule (workflows and formats) |

Agent setup (Codex and Claude Code share the pinned toolkit through committed skill entrypoints) is in [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md).
