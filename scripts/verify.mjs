#!/usr/bin/env node
// One command to verify any branch or worktree:
//
//   npm run verify                 lane scope (on lane branches), typecheck, lint, tests, build
//   npm run verify -- --quick      skip the production build
//   npm run verify -- --lane editor --base production
//
// Prints a toolkit-format evidence table (also written to .verify/report.md)
// that can be pasted into a task note's "Actual changes and evidence".
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { resolve } from "node:path";
import { ROOT, detectLane, loadLanes, revisionIdentity } from "./lib/lanes.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const quick = args.includes("--quick");
const lanes = loadLanes();
const lane = opt("lane") ?? detectLane(lanes);
const base = opt("base") ?? lanes.base;
const rev = revisionIdentity();
const env = `node ${process.version}, ${platform()} ${release()}`;

const checks = [];
if (lane) {
  checks.push({
    name: `Lane scope (${lane})`,
    cmd: ["node", ["scripts/lane.mjs", "check", lane, "--base", base]],
    expected: `only ${lane} owned paths changed vs ${base}`,
  });
}
checks.push(
  { name: "Agent skills", cmd: ["node", ["scripts/agent-skills.mjs", "check"]], expected: "both native skill sets match the pinned toolkit" },
  { name: "Typecheck", cmd: ["npm", ["run", "-s", "typecheck"]], expected: "next typegen + tsc --noEmit: 0 errors" },
  { name: "Lint", cmd: ["npm", ["run", "-s", "lint"]], expected: "eslint: 0 errors" },
  { name: "Unit + conformance tests", cmd: ["npm", ["run", "-s", "test"]], expected: "vitest run: all pass" },
);
if (!quick) checks.push({ name: "Production build", cmd: ["npm", ["run", "-s", "build"]], expected: "next build succeeds" });

const results = [];
for (const check of checks) {
  const [cmd, cmdArgs] = check.cmd;
  console.log(`\n━━ ${check.name}: ${cmd} ${cmdArgs.join(" ")}`);
  const started = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ ...check, pass: r.status === 0, observed: r.status === 0 ? `exit 0 in ${seconds}s` : `exit ${r.status} in ${seconds}s` });
}
if (quick) results.push({ name: "Production build", expected: "next build succeeds", pass: null, observed: "skipped (--quick)" });

const status = (p) => (p === null ? "not_run" : p ? "pass" : "fail");
const table = [
  "| Check | Revision/artifact | Environment | Expected | Observed | Status |",
  "| --- | --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.name} | ${rev.label} (${rev.branch}) | ${env} | ${r.expected} | ${r.observed} | ${status(r.pass)} |`),
].join("\n");

const failed = results.filter((r) => r.pass === false);
const summary = failed.length ? `✗ ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}` : "✓ all checks passed";
const report = `# Verification report\n\nGenerated ${new Date().toISOString()} by \`npm run verify${args.length ? " -- " + args.join(" ") : ""}\`.\n\n${table}\n\n${summary}\n`;
mkdirSync(resolve(ROOT, ".verify"), { recursive: true });
writeFileSync(resolve(ROOT, ".verify/report.md"), report);

console.log(`\n${table}\n\n${summary}\n(report saved to .verify/report.md)`);
process.exit(failed.length ? 1 : 0);
