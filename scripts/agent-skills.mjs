#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, legacyTarget, planSkills, syncSkills } from "./lib/agent-skills.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "check";
const root = args.length === 2 && args[0] === "--project"
  ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...params) => execFileSync("git", params, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  if (!["check", "sync", "preview", "prepare"].includes(command) || (args.length && !(args.length === 2 && args[0] === "--project"))) {
    throw new Error("Usage: node scripts/agent-skills.mjs <check|preview|sync|prepare> [--project <checkout>]");
  }
  if (command === "prepare") {
    // Run from the NEW central script before merging into an OLD Windows
    // checkout. Restore recognized links/junctions to their exact index text,
    // so Git can apply the file-to-directory change with core.symlinks=false.
    for (const agent of AGENTS) for (const path of [agent, `${agent}/skills`]) {
      try {
        const info = lstatSync(resolve(root, path));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing linked or non-directory parent: ${path}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (git("config", "--get", "core.symlinks").trim() !== "false") {
      throw new Error("prepare is only for legacy checkouts with core.symlinks=false. Normal symlink checkouts can merge directly.");
    }
    const entries = git("ls-files", "--stage", "-z", "--", ...AGENTS.map((agent) => `${agent}/skills`))
      .split("\0").filter(Boolean).map((entry) => entry.match(/^(\d+) ([a-f0-9]+) (\d)\t(.+)$/s));
    const repairs = [];
    for (const entry of entries) {
      if (!entry) throw new Error("Cannot parse Git index.");
      const [, mode, object, stage, path] = entry;
      if (stage !== "0") throw new Error("Resolve index conflicts before prepare.");
      if (mode !== "120000") continue;
      const parts = path.split("/");
      if (parts.length !== 3 || !AGENTS.includes(parts[0]) || parts[1] !== "skills") continue;
      const name = parts[2];
      const target = git("cat-file", "blob", object);
      if (!legacyTarget(target, name)) throw new Error(`Unrecognized indexed skill link: ${path}`);
      const absolute = resolve(root, path);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        if (!legacyTarget(readlinkSync(absolute), name)) throw new Error(`Unrecognized local skill link: ${path}`);
      } else if (!info.isFile() || readFileSync(absolute, "utf8") !== target) {
        throw new Error(`Local edits at ${path}; preserve them before prepare.`);
      }
      repairs.push({ path, absolute, target, link: info.isSymbolicLink() });
    }
    // Only these verified, tracked legacy paths get index flag changes.
    if (repairs.length) {
      const paths = repairs.map((entry) => entry.path);
      git("update-index", "--no-skip-worktree", "--", ...paths);
      git("update-index", "--no-assume-unchanged", "--", ...paths);
    }
    for (const entry of repairs) {
      if (entry.link) {
        unlinkSync(entry.absolute);
        writeFileSync(entry.absolute, entry.target);
      }
    }
    console.log(`Prepared ${repairs.length} legacy entries in ${root}. Apply the repair commit next, then run npm run skills:check.`);
  } else {
    const plan = command === "sync" ? syncSkills(root) : planSkills(root);
    const pending = plan.changes.filter(({ action }) => action !== "unchanged");
    for (const { path, action } of pending) console.log(`${action}: ${path}/SKILL.md`);
    if (command === "check" && pending.length) {
      throw new Error(`${pending.length} skill entrypoints need repair. Run npm run skills:sync and review the Git diff.`);
    }
    console.log(`${plan.changes.length} native skill entrypoints; ${pending.length} ${command === "sync" ? "changed" : "pending"}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
