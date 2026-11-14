#!/usr/bin/env node
// Lane worktree helper.
//
//   npm run lane:create -- <lane> [--base production]   new branch + worktree, then setup
//   npm run lane:setup                                   submodule, both skill sets, npm ci
//   npm run lane:check -- [lane] [--base production]     is this branch inside its owned paths?
//   node scripts/lane.mjs list                           lanes and owned paths
//
// Lanes, branches and owned paths come from lanes.json.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, changedFiles, classify, currentBranch, detectLane, git, loadLanes, tryGit } from "./lib/lanes.mjs";

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
const lanes = loadLanes();

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}${cwd && cwd !== ROOT ? `   (in ${cwd})` : ""}`);
  const r = spawnSync(cmd, args, { cwd: cwd ?? ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function setup(dir) {
  run("git", ["submodule", "update", "--init", "--recursive"], dir);
  run("node", ["scripts/agent-skills.mjs", "check"], dir);
  run("npm", ["ci"], dir);
  console.log(`\nready: ${dir}\n  npm run verify      all gates\n  npm run dev         then open http://localhost:3000`);
}

function create(laneKey) {
  const lane = lanes.lanes[laneKey];
  if (!lane) {
    console.error(`unknown lane "${laneKey}". Lanes: ${Object.keys(lanes.lanes).join(", ")}`);
    process.exit(1);
  }
  const base = flag("base") ?? lanes.base;
  const dir = resolve(ROOT, flag("path") ?? lane.worktree);
  if (!tryGit(["rev-parse", "--verify", "--quiet", base])) {
    console.error(`base "${base}" does not exist. Merge the baseline first or pass --base <ref>.`);
    process.exit(1);
  }
  if (existsSync(dir)) {
    console.error(`${dir} already exists; remove it or pass --path <dir>.`);
    process.exit(1);
  }
  const branchExists = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${lane.branch}`]);
  run("git", branchExists ? ["worktree", "add", dir, lane.branch] : ["worktree", "add", "-b", lane.branch, dir, base]);
  setup(dir);
  console.log(`\n${lane.title} lane (${lane.task}) on ${lane.branch}. Task note: docs/changes/${lane.task}.md`);
}

function check(laneKeyArg) {
  const laneKey = laneKeyArg ?? detectLane(lanes);
  if (!laneKey || !lanes.lanes[laneKey]) {
    console.log(`branch "${currentBranch()}" is not a lane branch; pass a lane: ${Object.keys(lanes.lanes).join(", ")}`);
    return 0;
  }
  const base = flag("base") ?? lanes.base;
  const { mergeBase, files } = changedFiles(base, lanes.ignore);
  const rows = files.map((f) => ({ file: f, kind: classify(f, laneKey, lanes) }));
  const violations = rows.filter((r) => r.kind !== "owned" && r.kind !== "dependency");
  const deps = rows.filter((r) => r.kind === "dependency");
  console.log(`lane ${laneKey} (${lanes.lanes[laneKey].task}) vs ${base} @ ${mergeBase.slice(0, 12)}: ${files.length} changed file(s)`);
  for (const r of rows) {
    const mark = r.kind === "owned" ? "ok  " : r.kind === "dependency" ? "note" : "STOP";
    const why =
      r.kind === "contract"
        ? "contract change: propose in the task note; integration owner must approve"
        : r.kind.startsWith("other-lane:")
          ? `owned by the ${r.kind.slice(11)} lane`
          : r.kind === "shared"
            ? "shared path: needs integration-owner approval"
            : r.kind === "dependency"
              ? "dependency change: list it in the task note"
              : "";
    console.log(`  ${mark} ${r.file}${why ? `  — ${why}` : ""}`);
  }
  if (deps.length) console.log(`\n${deps.length} dependency file(s) changed; record why in docs/changes/${lanes.lanes[laneKey].task}.md`);
  if (violations.length) {
    console.log(`\n✗ ${violations.length} file(s) outside lane ${laneKey}'s owned paths`);
    return 1;
  }
  console.log(`\n✓ all changes are inside lane ${laneKey}'s owned paths`);
  return 0;
}

switch (command) {
  case "create":
    if (!positional[0]) {
      console.error("usage: npm run lane:create -- <lane>");
      process.exit(1);
    }
    create(positional[0]);
    break;
  case "setup":
    setup(ROOT);
    break;
  case "check":
    process.exit(check(positional[0]));
    break;
  case "list":
    for (const [key, lane] of Object.entries(lanes.lanes)) {
      console.log(`${key}: ${lane.title} — ${lane.task} on ${lane.branch} (worktree ${lane.worktree})`);
      for (const g of lane.owns) console.log(`    ${g}`);
    }
    console.log(`\nbase: ${lanes.base}; current branch: ${currentBranch()}; worktrees:\n${git(["worktree", "list"])}`);
    break;
  default:
    console.log("usage: node scripts/lane.mjs <create|setup|check|list> ...");
    process.exit(command ? 1 : 0);
}
