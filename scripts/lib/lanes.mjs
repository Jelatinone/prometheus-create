// Shared helpers for lane.mjs and verify.mjs. Plain Node (no dependencies).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function loadLanes() {
  return JSON.parse(readFileSync(resolve(ROOT, "lanes.json"), "utf8"));
}

export function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tryGit(args, opts) {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

/** Glob -> RegExp. Supports `**`, `*`; everything else (incl. [brackets]) is literal. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function currentBranch() {
  return tryGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
}

/** Lane key whose branch matches the current branch, or null. */
export function detectLane(lanes, branch = currentBranch()) {
  for (const [key, lane] of Object.entries(lanes.lanes)) if (lane.branch === branch) return key;
  return null;
}

/**
 * Files changed since the merge-base with `base`: committed, staged, unstaged
 * and untracked, minus machine-local paths (lanes.json `ignore`, e.g. the
 * .claude/skills junctions that lane:setup creates).
 */
export function changedFiles(base, ignore = []) {
  if (!tryGit(["rev-parse", "--verify", "--quiet", base]))
    throw new Error(`base ref "${base}" not found; pass --base <ref>`);
  const mergeBase = git(["merge-base", "HEAD", base]);
  const tracked = git(["diff", "--name-only", mergeBase]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  const files = [...new Set([...tracked, ...untracked])].filter((f) => f && !matchesAny(f, ignore)).sort();
  return { mergeBase, files };
}

/**
 * Classify a changed path for a lane:
 *   owned | dependency | contract | other-lane:<key> | shared
 */
export function classify(path, laneKey, lanes) {
  const lane = lanes.lanes[laneKey];
  if (matchesAny(path, lane.owns)) return "owned";
  if (lanes.dependencyFiles.includes(path)) return "dependency";
  if (matchesAny(path, lanes.contractPaths)) return "contract";
  for (const [key, other] of Object.entries(lanes.lanes)) {
    if (key !== laneKey && matchesAny(path, other.owns)) return `other-lane:${key}`;
  }
  return "shared";
}

export function revisionIdentity() {
  const sha = tryGit(["rev-parse", "--short=12", "HEAD"]) ?? "unknown";
  const dirty = (tryGit(["status", "--porcelain"]) ?? "").length > 0;
  return { sha, dirty, label: dirty ? `${sha}+dirty` : sha, branch: currentBranch() };
}
