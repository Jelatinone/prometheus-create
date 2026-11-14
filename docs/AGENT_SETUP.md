# Shared agent setup

The central repository tracks small `SKILL.md` adapters in `.agents/skills/`
(Codex) and `.claude/skills/` (Claude Code). Each retains the canonical workflow's
name and description and links relatively to `toolkit/.agents/skills/`. The
pinned submodule remains the single source of workflow instructions, templates,
and references. Both clients use the shared commands in `package.json` from the
project root; `CLAUDE.md` imports `AGENTS.md` for the same operating rules.

Ordinary Git files work with either value of `core.symlinks`, on Windows without
Developer Mode or administrator privileges, and in differently named checkouts.
No machine-local junction, global Git setting, or index hiding is needed. This
sets up repository workflows and tools; it does not install external MCP servers
or change account-wide agent configuration.

The layout follows [Codex's local skill discovery](https://learn.chatgpt.com/docs/build-skills)
and [Claude Code's project skills](https://code.claude.com/docs/en/skills).
Git's [core.symlinks setting](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks)
explains why the old tracked links became plain text on some checkouts. The old
links also embedded an absolute path to the original Windows checkout.

## Fresh checkout

From that checkout's root:

```sh
npm run lane:setup
```

This initializes the recorded submodule, checks both skill sets, and runs
`npm ci`. It only operates on the invoking checkout. Equivalently:

```sh
git submodule update --init --recursive
npm ci
npm run skills:check
```

Start a new Codex or Claude Code session rooted in the checkout to refresh skill
discovery. Invoke a relevant workflow as `$recap-project` in Codex or
`/recap-project` in Claude Code. Client account policies can still restrict
skills; filesystem validation does not prove a client UI has loaded them.

## Existing worktrees: manual rollout

The repair is applied only to the central checkout. Cody chooses when to merge
it into capture, platform and editor; nothing in this repair scans or updates
those worktrees automatically.

1. Finish or preserve the worktree's current edits. Record its branch and
   `git status --short`. Do not merge through unrelated dirty work.
2. On Windows with the old junction setup and `core.symlinks=false`, run the new
   script **from the central checkout**, targeting only the current worktree.
   In PowerShell, from the worktree root (adjust the central path if moved):

   ```powershell
   node C:/Workflows/Personal/prometheus-create/scripts/agent-skills.mjs prepare --project .
   git status --short
   ```

   `prepare` verifies all old tracked skill links before changing anything,
   clears their `skip-worktree`/`assume-unchanged` flags, and replaces only the
   recognized link itself with its exact committed text. Git can then apply the
   file-to-directory change cleanly. The toolkit target is never deleted. It
   refuses local skill edits and unfamiliar targets. The temporary text files
   do not expose skills: immediately continue to step 3. If no legacy links
   remain, it reports zero repairs. With native Git symlinks (`core.symlinks=true`),
   skip this preparation and merge normally from a clean checkout.
3. Merge the repair branch/commit supplied in the task handoff. For example,
   once the repair is committed on its named branch:

   ```sh
   git merge codex/fix-agent-skills
   git submodule update --init --recursive
   npm run skills:check
   npm run verify
   ```

   Resolve any genuine shared-file conflicts deliberately. Merging the same
   repair history into all lanes keeps those shared changes in their merge base
   after integration; independently copying files or cherry-picking can make
   the lane scope check report them as new shared changes. If that happens,
   compare against the repair commit with `npm run verify -- --base <repair-sha>`
   until the integration owner advances `production` to include the repair.
4. Confirm all twelve skills have ordinary `SKILL.md` files in both directories,
   `git status --short` is clean, and restart the agent session. Skill changes are
   now shared tracked changes and are no longer excluded by `lanes.json`.

No dependency versions changed, so an already installed worktree does not need
`npm ci` just for this repair. If dependencies are absent, use `npm run lane:setup`.
The three active worktrees were deliberately not used as test fixtures.

## Maintaining skills and using tools

| Command | Purpose |
| --- | --- |
| `npm run skills:check` | Read-only validation of both native skill sets against the local pinned toolkit; missing source, drift, edited adapters and legacy links fail clearly |
| `node scripts/agent-skills.mjs preview` | Show proposed adapter changes without writing |
| `npm run skills:sync` | Create missing entrypoints, migrate recognized legacy entries, refresh intact generated adapters; review and commit the diff |
| `npm run verify` | Skill check, typecheck, lint, tests and build; lane scope check when applicable |
| `npm run validate -- list` | List supported artifact contracts |
| `npm run validate -- <contract> <file>` | Validate a JSON artifact or use `glb` for a mesh |
| `npm run lane:check` | Check ownership boundaries on a lane branch |

After an intentional toolkit upgrade, preview and sync adapters, inspect the
diff, run verification, and commit the submodule pin and adapters together.
Checksums identify intact generated files (normalized to LF); user edits are
never overwritten. Custom skills and extra resources are preserved. Obsolete
generated skills require explicit review/removal. The script does not fetch a
new toolkit revision, install packages, change global Git config, or hide files
from Git. The advertised toolkit bootstrap executable is absent at the current
pin, so these small project-owned commands implement its documented adapter
format.
