# prometheus-create

Project root is this repository. `toolkit/` is the pinned hackathon-toolkit submodule: it supplies workflows and formats; project files and Git operations stay in this root.

- **Before any task**, read `toolkit/docs/PROJECT_CONTRACT.md`, `toolkit/docs/FORMATS.md`, the relevant `PLAN.md` sections, and your task note `docs/changes/<TASK-ID>.md`. Write your implementation plan into the task note before editing code.
- **Lane work**: your lane in `lanes.json` defines your branch and owned paths. Edit those paths and your task note; propose anything else in the task note. Protocol: `docs/LANES.md`.
- **Contracts**: `lib/contracts` is the shared source of truth. Import schemas and types from `@/lib/contracts`, depend on the ports in `lib/contracts/ports.ts`, and use `MemoryBackend` from `lib/reference` until the platform backend exists. Contract changes are proposals approved by the integration owner (Cody) first.
- **Done** means `npm run verify` passes on your branch and its evidence table is in your task note, with status `ready_for_review`.
- Canonical 3D: right-handed, meters, +Y up, quaternions `[x, y, z, w]`. Source time is integer microseconds; take time is integer frames at a rational rate; revisions are separate from both.

Gotchas:

- TypeScript scripts run through `tsx` as `.mts` files and import leaf modules (`lib/contracts/common`, `lib/contracts/registry`): Node cannot see re-exports of the CJS-transpiled `lib/contracts/index.ts`.
- After editing a contract, run `npm run contracts:schema` (a test fails while the JSON Schema is stale). After regenerating the GLB fixture, update its hash in `fixtures/contracts`.
- A fresh worktree needs `npm run lane:setup` once (submodule, `npm ci`, `.claude/skills` junctions; `core.symlinks` is off on Windows).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
