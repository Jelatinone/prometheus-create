# Lanes: parallel agent work

**Current work: Track A and Track B (Cody, PLAN v4, 2026-11-14).** Two agents run in parallel. **Track A** (lane key `track-a`) is generation: task HK-011, branch `feat/HK-011-track-a`, worktree `../prometheus-create-capture`, port 3001, checkpoints CP-007 to CP-010. **Track B** (lane key `track-b`) is the editor: task HK-012, branch `feat/HK-012-track-b`, worktree `../prometheus-create-editor`, port 3003, checkpoints CP-011 to CP-015. Start an agent with `implement-next-checkpoint` assigned to HK-011 (Track A) or HK-012 (Track B), from that track's worktree. It takes the earliest checkpoint of that track not yet `ready_for_review`/`complete`, does exactly that one and stops. Seams S1 to S5 and the track rule are in PLAN §1 "Current continuation v4". The platform lane has no agent. The v3 single-agent override and the older lane assignments (HK-002/HK-003/HK-004) are historical.

Three lanes build on the HK-001 baseline at the same time, each on its own branch and worktree. `lanes.json` is the single source for each lane's task ID, branch, worktree path, and **owned paths**. PLAN.md §5 records the proposed replan; it needs Cody's approval before lanes start.

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
- **Fixtures** — `fixtures/contracts/*.json` (golden and invalid cases) and `public/fixtures/axis-box.glb` (0.4 × 0.9 × 0.2 m; unequal sides expose axis and unit mistakes).
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
npm run lane:create -- track-b
```

This creates the lane's branch (for `track-b`, `feat/HK-012-track-b`) from `production`, adds the worktree at its `worktree` path, initializes the toolkit submodule, checks the tracked Codex and Claude skill entrypoints, and runs `npm ci`. In a worktree created another way (for example by Claude Code), run `npm run lane:setup` inside it once. The entrypoints use relative links into that worktree's own toolkit; setup does not create junctions or hide index changes. For an existing worktree from before this repair, follow [manual migration](AGENT_SETUP.md) before merging the repair commit.

Then point the agent at its task note, for example: "Use implement-next-checkpoint for HK-012 (Track B)."

## Verifying a lane yourself

From the lane's worktree:

```bash
npm run verify
```

One pass/fail table: lane scope, typecheck, lint, unit and conformance tests, production build (`-- --quick` skips the build). The same table is saved to `.verify/report.md`.

To check output by hand, run the lane's app on its port (`npm run dev -- -p 3003`) and validate anything it produces: `npm run validate -- <contract> file.json` for JSON (a saved manifest, an export manifest, a capture-agent payload), `npm run validate -- glb file.glb` for a mesh.

Finally, read the lane's task note: claimed behavior, evidence table, limitations, and any proposed contract deviations.
