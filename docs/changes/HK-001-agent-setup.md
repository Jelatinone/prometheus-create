# Task outcome and evidence

Bounded maintenance follow-up to allocated task HK-001; the original foundation and its merge record remain in [HK-001.md](HK-001.md). This is not a new checkpoint or lane assignment. Cody authorized the shared setup repair and local commits in this chat on 2026-11-14, then explicitly limited application to the central checkout; the three active worktrees must remain untouched.

```yaml
schema_version: 2
id: "HK-001"
checkpoint_id: "CP-001"
status: "ready_for_review"
branch: "codex/fix-agent-skills"
base_ref: "23ba9c9"
owner: "Cody (implemented by Codex)"
created_at: "2026-11-14T15:00:00-06:00"
updated_at: "2026-11-14T15:46:00-06:00"
plan_version_at_start: 2
feature_ids: []
contract_ids: []
depends_on: []
owned_paths: [".agents/skills/**", ".claude/skills/**", "scripts/agent-skills.mjs", "scripts/lib/agent-skills.mjs", "scripts/lane.mjs", "scripts/verify.mjs", "scripts/lib/lanes.mjs", "tests/agent-skills.test.ts", "tests/lanes.test.ts", "package.json", "lanes.json", "AGENTS.md", "CLAUDE.md", "README.md", "docs/LANES.md", "docs/AGENT_SETUP.md", "docs/changes/HK-001-agent-setup.md"]
```

## 1. Outcome and acceptance

**Objective:** make the central checkout's shared toolkit workflows and repository tools usable by both Codex and Claude Code through ordinary Git-tracked files. **Visible flow:** given a checkout with `core.symlinks=false`, both native skill directories expose twelve readable `SKILL.md` entrypoints whose relative links resolve to that checkout's pinned toolkit; setup and validation leave Git clean. **Edge cases:** legacy absolute symlinks, Windows junctions and text placeholders; missing toolkit; edited adapters and unrelated skill directories. **Out of scope:** applying to active worktrees, global agent settings, new MCP services, toolkit upgrades, application contracts/features, remote publication. **Fallback:** retain the pinned toolkit; report any blocked local migration honestly.

## 2. Implementation plan

### Objective

Replace machine-specific links and Git index hiding with portable, tracked native adapters and a shared check/sync tool.

### Scope and exclusions

Only the owned central-checkout paths above. Canonical workflow bodies stay in the submodule. The user will apply the completed change to worktrees manually. No worktree enumeration is needed to implement this repair.

### Inputs and baseline

Central checkout `production` at `23ba9c9`; toolkit index pin `d34da50829c5ded6c3e38bf0415d82b7419a983e`; 24 tracked mode-120000 entries with absolute Windows targets; `core.symlinks=false`. Existing lane setup repairs only Claude links and uses `skip-worktree`; lane checks ignore Claude skill changes. Toolkit FORMATS defines checksum-marked native adapters; its advertised bootstrap executable is absent at this pin. Read PROJECT_CONTRACT, FORMATS, PLAN sections 5-6, the HK-001 note, accepted decisions, local Next documentation index (no Next API changes), and official native skill discovery documentation before implementation.

### Ordered steps

| Step | Outcome | Task IDs | Owned paths | Dependencies | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | Dependency-free adapter preview/check/sync with guarded legacy migration | HK-001 | scripts/agent-skills.mjs, scripts/lib/agent-skills.mjs, tests/agent-skills.test.ts | None | Missing source and collision fail before writes; repeated sync unchanged |
| 2 | Both native skill sets stored as regular files with relative canonical links | HK-001 | .agents/skills/**, .claude/skills/** | 1 | Twelve skills each; canonical metadata matches; no absolute paths or index hiding |
| 3 | Shared setup/verification and lane ownership checks | HK-001 | package.json, scripts/lane.mjs, scripts/verify.mjs, scripts/lib/lanes.mjs, lanes.json, tests/lanes.test.ts | 2 | Skill check runs in setup and verify; shared adapters are not ignored |
| 4 | Central verification and manual rollout instructions | HK-001 | AGENTS.md, CLAUDE.md, README.md, docs/LANES.md, docs/AGENT_SETUP.md, this note | 3 | npm run verify; isolated Git checkout tests; exact evidence and commits |

### Acceptance and verification

Run focused migration/Git portability tests, adapter validation, `git diff --check`, and full `npm run verify`. Use isolated temporary repositories to exercise checkout portability without touching any active worktree. Record native UI discovery separately from filesystem/format checks; do not claim a client session was tested if it was not.

### Risks and rollback

Never traverse a link when replacing it; remove only the recognized link itself. Refuse to overwrite user-authored files and preflight the complete migration before writes. Clear legacy index flags only for known old tracked skill entries. Revert the maintenance commit to roll back; the original absolute links will again be machine-specific. The toolkit pin and source bodies stay unchanged.

### Decisions requiring approval

None beyond the user's explicit setup-repair and local-commit authorization. Applying to active worktrees is expressly excluded. An initial automatic approval review failed due to an account usage limit; a later review allowed the central migration, branch creation and verification. No approval blocker remains.

## 3. Actual changes and evidence

**Delivered behavior:** all 24 absolute symlinks are replaced by ordinary tracked native adapters (12 workflows for each client), using canonical metadata and relative links to the unchanged pinned toolkit. `skills:check`, preview and `skills:sync` detect drift and preserve edited/user-owned files. Lane setup checks both clients instead of creating junctions and hiding changes. Full verification includes the skill check; lane ownership no longer ignores Claude skills. The standalone `prepare --project` command and `docs/AGENT_SETUP.md` support Cody's later manual worktree migration without running the old lane setup. No dependency versions or lockfile changed.

| Revision/artifact | Paths/components | Observable behavior |
| --- | --- | --- |
| 23ba9c9 | Existing skill links/setup | Absolute links and Claude-only junction workaround confirmed |
| 23ba9c944896+dirty repair tree | Native adapters, scripts, tests, docs | Portable discovery, guarded migration and shared tools; implementation snapshot committed with this note |

| Check | Revision/artifact | Environment | Expected | Observed | Status |
| --- | --- | --- | --- | --- | --- |
| Baseline inspection | 23ba9c9 | Windows, central checkout | Identify portability failure | 24 absolute tracked symlinks; core.symlinks=false | pass |
| Agent skills | 23ba9c944896+dirty (codex/fix-agent-skills) | node v22.18.0, win32 10.0.26200 | both native skill sets match the pinned toolkit | exit 0 in 0.1s; 24 entrypoints, 0 pending | pass |
| Typecheck | 23ba9c944896+dirty (codex/fix-agent-skills) | node v22.18.0, win32 10.0.26200 | next typegen + tsc --noEmit: 0 errors | exit 0 in 4.3s | pass |
| Lint | 23ba9c944896+dirty (codex/fix-agent-skills) | node v22.18.0, win32 10.0.26200 | eslint: 0 errors | exit 0 in 14.4s | pass |
| Unit + conformance tests | 23ba9c944896+dirty (codex/fix-agent-skills) | node v22.18.0, win32 10.0.26200 | vitest run: all pass | 101 tests in 7 files; exit 0 in 6.1s | pass |
| Production build | 23ba9c944896+dirty (codex/fix-agent-skills) | node v22.18.0, win32 10.0.26200 | next build succeeds | exit 0 in 8.8s; static / and /_not-found | pass |
| Migration and Git portability | Same implementation; tests/agent-skills.test.ts | Isolated temporary Git repositories, paths with spaces, Windows junctions | Both core.symlinks settings clone cleanly; legacy migration preserves target and clears flags | All 8 tests pass, including old-junction preparation followed by applying the file-to-directory repair commit | pass |
| Skill-creator quick_validate.py | All 24 new native SKILL.md files | Python 3.13 | Valid frontmatter and names | All 24 report Skill is valid | pass |
| Patch and submodule | Central repair tree; toolkit d34da50829c5ded6c3e38bf0415d82b7419a983e | Git for Windows | No whitespace defects or toolkit edits | git diff --check exit 0; toolkit status empty and HEAD equals pin | pass |

**Known limitations / not tested:** active worktrees intentionally untouched. Native Codex/Claude UI discovery was not reloaded/tested; the checks establish filesystem layout, metadata and canonical link resolution. Claude CLI is not installed on PATH in this environment. Existing sessions may need restarting. No Linux/macOS native run was performed; Git checkout was tested on Windows with both symlink settings. The toolkit's advertised bootstrap executable remains absent at this pin; project-owned commands follow its documented adapter format. Initial sandbox-only junction tests failed because link creation was denied; the normal-permission run passed. Temporary Git fixtures disable inherited commit signing/hooks in their own local config only. An initial migration test exposed that Git handles index flags separately; this was corrected and all gates then passed.

## 4. Proposed deviations

| Change ID | Approved baseline / contract | Proposed deviation | Reason | Impacted consumers | Alternatives | Approval state | Approval reference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HK-001-agent-setup | Shared setup and native skill entrypoints | Replace absolute symlinks/junction workaround with tracked adapters; expose checks to both clients | Portable clones and manual worktree rollout without Git hiding | All three lanes when Cody applies the fix | Relative symlinks still require platform support; ignored junctions require setup and hide drift | accepted | Cody's 2026-11-14 request to fix shared skills/tools and Git compatibility; central checkout only |

## 5. Handoff and merge gate

- [x] Owned scope or explicit cross-owner agreement.
- [x] Representative behavior and edge case verified.
- [x] Required checks pass.
- [x] Contracts preserved.
- [x] No secrets/private data in changes.
- [x] Rollback and unfinished work recorded.

```yaml
reviewer: null
review_status: "pending"
approval_ref: null
integration_commit: null
merged_at: null
stable_release_including_change: null
rollback: "Revert the local maintenance commit; no toolkit or active-worktree changes."
```

**Integrator note:** Cody retains review/integration ownership and will manually apply the completed patch to each active worktree. No push is requested.
