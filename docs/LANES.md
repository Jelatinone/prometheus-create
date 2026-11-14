# Lanes: parallel agent work

Three lanes build on the HK-001 baseline at the same time, each on its own branch and worktree. `lanes.json` is the single source for each lane's task ID, branch, worktree path, lab page, and **owned paths**. PLAN.md §5 records the proposed replan; it needs Cody's approval before lanes start.

| Lane | Task | Builds | Hands to |
| --- | --- | --- | --- |
| `capture` | HK-002 | Upload/phone/video/Chert adapters that emit `SourceRegistration` + `IngestEnvelope`; reconstruction jobs (`ReconstructionJob`) and mesh normalization; `services/capture-agent` (Python) | Platform's ingest endpoint; editor's capture panel (`components/capture`) |
| `platform` | HK-003 | A real `Backend` (TigerData + Supabase Auth/Storage): projects, revisions, assets, ingestion, jobs; HTTP routes; auth | Editor and capture swap `MemoryBackend` for it |
| `editor` | HK-004, HK-005 | Viewport, selection, transforms, undo, takes and fork, PNG/GLB export | The demo journey |

## What every lane starts with

- **Contracts** — `lib/contracts` (import from `@/lib/contracts`). Zod schemas for CT-001..CT-005, pure rules (`forkManifest`, `checkExpectedRevision`, `classifyFrame`, `transitionJob`, `canApplyJobResult`, `sourceTimeAtTakeFrame`), and generated JSON Schema in `lib/contracts/json-schema/` for the Python agent.
- **Ports** — `lib/contracts/ports.ts`: `ProjectRepository`, `AssetCatalog`, `IngestionGateway`, `JobStore`, bundled as `Backend`. Every method returns `Result<T>`; `HTTP_STATUS` maps error codes to HTTP.
- **Reference backend** — `lib/reference/memory-backend.ts` (`new MemoryBackend()`), the executable reading of the port semantics. Build and test against it until the platform lands.
- **Conformance suite** — `tests/conformance/backend-conformance.ts`. The platform's backend must pass `describeBackendConformance(...)` unchanged; that is how "works like the reference" is proven.
- **Fixtures** — `fixtures/contracts/*.json` (golden and invalid cases, importable from `@/fixtures`) and `public/fixtures/axis-box.glb` (0.4 × 0.9 × 0.2 m; unequal sides expose axis and unit mistakes).
- **A lab page** — `app/lab/<lane>/page.tsx` is reserved for the lane's hand-checkable demo. Replace the placeholder.
- **A task note** — `docs/changes/<TASK-ID>.md` holds the assignment; the lane writes its plan and evidence there.

## Rules

1. Edit only your lane's owned paths plus your task note. `npm run lane:check` lists anything outside them.
2. Shared paths (contracts, fixtures, conformance tests, scripts, app shell, PLAN, AGENTS) change only with integration-owner approval. Propose the change as a row in your task note's "Proposed deviations" table with the impacted lanes, then wait.
3. Adding dependencies is allowed: edit `package.json` via `npm install <pkg>` and say why in the task note. On merge, the integrator resolves `package-lock.json` conflicts by taking either side and running `npm install`.
4. Before handing off, `npm run verify` passes on the branch and its table is pasted into the task note. Status ends at `ready_for_review`; merging is the integrator's step.
5. Runtime resources are per worktree: run the dev server on the lane's own port (`npm run dev -- -p 3001` capture, `3002` platform, `3003` editor). Only the platform lane uses the shared test database and storage bucket; secrets live in each worktree's ignored `.env.local`.

## Starting a lane

Prerequisite: the baseline is merged into `production` (the `base` in `lanes.json`).

```bash
npm run lane:create -- editor
```

This creates `feat/HK-004-editor` from `production`, adds the worktree at `../prometheus-create-editor`, initializes the toolkit submodule, runs `npm ci`, and links `.claude/skills` to the worktree's toolkit. In a worktree created another way (for example by Claude Code), run `npm run lane:setup` inside it once.

Then point the agent at its task note, for example: "Implement HK-004 as assigned in docs/changes/HK-004.md."

## Verifying a lane yourself

From the lane's worktree:

```bash
npm run verify
```

One pass/fail table: lane scope, typecheck, lint, unit and conformance tests, production build (`-- --quick` skips the build). The same table is saved to `.verify/report.md`.

```bash
npm run dev -- -p 3003
```

Then open `http://localhost:3003/lab` and the lane's page (`/lab/editor`, `/lab/platform`, `/lab/capture`). Use `/lab/validate` to check any JSON the lane produces (a saved manifest, an export manifest, a capture-agent payload) and `/lab/glb` to check any mesh. CLI equivalents: `npm run validate -- auto file.json` and `npm run validate -- glb file.glb`.

Finally, read the lane's task note: claimed behavior, evidence table, limitations, and any proposed contract deviations.
