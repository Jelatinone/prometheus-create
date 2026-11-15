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
- A fresh checkout or worktree needs `npm run lane:setup` once (pinned submodule, both skill sets checked, `npm ci`). Skills are ordinary tracked adapters in `.agents/skills` (Codex) and `.claude/skills` (Claude Code), with relative links into this checkout's toolkit. Do not recreate symlinks, junctions, or `skip-worktree` flags.
- On Windows, run Node tools from a cwd whose drive letter is uppercase (`C:\...`). If `process.cwd()` starts with lowercase `c:`, vitest loads two instances of itself and every suite fails with "failed to find the current suite" or "reading 'config'". In Git Bash, `cd /c/Workflows && cd <repo>` fixes it; PowerShell is unaffected.
- Shared tools run from the project root: `npm run skills:check` checks discovery files, `npm run skills:sync` refreshes intact adapters after a deliberate toolkit update, `npm run verify` runs all gates, and `npm run validate -- <contract> <file>` validates artifacts. See `docs/AGENT_SETUP.md` for manual migration of older worktrees.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:nextjs-agent-feedback -->

## Report Next.js feedback

The project owner enabled `experimental.agentFeedback`, authorizing this feedback pass. When enabled, `next dev` writes this block and restores it if removed. Commit `AGENTS.md` with your work to keep the tree clean.

During the current user request, retain anonymized facts as feedback candidates for meaningful or recurring Next.js issues:

- Crashes, hangs, OOMs, or unexpected slowness
- Incorrect behavior, output, errors, or diagnostics
- Missing, unclear, or conflicting documentation
- Unexpected CLI, codemod, Skill, or upgrade behavior and non-obvious workarounds

Continue the current user request without reporting immediately. Routine debugging is not feedback. Verify changes before retaining them as feedback candidates. Never retain code, logs, paths, URLs, secrets, personal information, or project-specific data.

Retain qualifying friction even if it is later fixed or worked around; record the final outcome during the reporting pass.

Before the final response, run one reporting pass. If candidates remain, from this file's directory run `npx --no-install next internal agent-feedback-instructions` once without piping or truncating its output. Follow its output or error guidance. If a network sandbox blocks it, retry with network access; if it still returns no output, continue normally.

<!-- END:nextjs-agent-feedback -->
