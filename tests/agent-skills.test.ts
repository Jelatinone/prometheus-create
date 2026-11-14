import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS, planSkills, syncSkills } from "../scripts/lib/agent-skills.mjs";
import { REPO_ROOT } from "./helpers/fixtures";

const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "agent skills "));
  temporary.push(root);
  write(root, "toolkit/.agents/skills/example/SKILL.md", '---\nname: "example"\ndescription: "An example workflow."\n---\n\nCanonical instructions.\n');
  return root;
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function init(root: string) {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", resolve(root, "no-hooks"));
}
afterEach(() => {
  for (const root of temporary.splice(0)) {
    // Only fixture roots returned by mkdtemp under the OS temp directory.
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir(), "agent skills "))) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("portable agent skills", () => {
  it("exposes both clients with local canonical links and idempotent sync", () => {
    const root = fixture();
    syncSkills(root);
    for (const agent of AGENTS) {
      const entry = resolve(root, agent, "skills/example/SKILL.md");
      expect(lstatSync(dirname(entry)).isSymbolicLink()).toBe(false);
      const content = readFileSync(entry, "utf8");
      const link = content.match(/\[Canonical workflow\]\(([^)]+)\)/)![1];
      expect(resolve(dirname(entry), link)).toBe(resolve(root, "toolkit/.agents/skills/example/SKILL.md"));
      expect(readFileSync(resolve(dirname(entry), link), "utf8")).toContain("Canonical instructions.");
    }
    expect(syncSkills(root).changes.every((entry: { action: string }) => entry.action === "unchanged")).toBe(true);
  });

  it("migrates Git text placeholders and Windows junctions without touching targets", () => {
    const root = fixture();
    write(root, ".agents/skills/example", "C:/old-checkout/toolkit/.agents/skills/example");
    mkdirSync(resolve(root, ".claude/skills"), { recursive: true });
    const target = resolve(root, "toolkit/.agents/skills/example");
    const original = readFileSync(resolve(target, "SKILL.md"), "utf8");
    symlinkSync(target, resolve(root, ".claude/skills/example"), process.platform === "win32" ? "junction" : "dir");
    syncSkills(root);
    expect(readFileSync(resolve(target, "SKILL.md"), "utf8")).toBe(original);
    for (const agent of AGENTS) expect(lstatSync(resolve(root, agent, "skills/example")).isSymbolicLink()).toBe(false);
  });

  it("preflights all destinations and preserves user edits, unrelated skills and resources", () => {
    const root = fixture();
    write(root, ".agents/skills/example", "C:/old/toolkit/.agents/skills/example");
    write(root, ".claude/skills/example/SKILL.md", "User content");
    expect(() => syncSkills(root)).toThrow("user-owned or edited");
    expect(lstatSync(resolve(root, ".agents/skills/example")).isFile()).toBe(true);
    expect(readFileSync(resolve(root, ".claude/skills/example/SKILL.md"), "utf8")).toBe("User content");
    const other = fixture();
    write(other, ".agents/skills/custom/SKILL.md", "Custom skill");
    syncSkills(other);
    write(other, ".agents/skills/example/resources.txt", "Keep resource");
    syncSkills(other);
    expect(readFileSync(resolve(other, ".agents/skills/custom/SKILL.md"), "utf8")).toBe("Custom skill");
    expect(readFileSync(resolve(other, ".agents/skills/example/resources.txt"), "utf8")).toBe("Keep resource");
  });

  it("refreshes intact adapters after source metadata changes, tolerates CRLF, rejects edited adapters", () => {
    const root = fixture();
    syncSkills(root);
    const entry = resolve(root, ".agents/skills/example/SKILL.md");
    writeFileSync(entry, readFileSync(entry, "utf8").replace(/\n/g, "\r\n"));
    expect(planSkills(root).changes.every((change: { action: string }) => change.action === "unchanged")).toBe(true);
    const canonical = "toolkit/.agents/skills/example/SKILL.md";
    write(root, canonical, readFileSync(resolve(root, canonical), "utf8").replace("An example workflow.", "Updated description."));
    syncSkills(root);
    expect(readFileSync(entry, "utf8")).toContain("Updated description.");
    writeFileSync(entry, readFileSync(entry, "utf8") + "User edit\n");
    expect(() => syncSkills(root)).toThrow("user-owned or edited");
  });

  it("fails clearly without toolkit and refuses linked destination parents", () => {
    const root = fixture();
    expect(() => syncSkills(resolve(root, "missing"))).toThrow("Toolkit skills are missing");
    const outside = fixture();
    mkdirSync(resolve(root, ".agents"));
    symlinkSync(outside, resolve(root, ".agents/skills"), process.platform === "win32" ? "junction" : "dir");
    expect(() => syncSkills(root)).toThrow("refusing to follow or replace");
    expect(readdirSync(outside)).toEqual(["toolkit"]);
    expect(existsSync(resolve(root, ".claude"))).toBe(false);
  });

  it.each(["false", "true"])("survives a Git clone with core.symlinks=%s and stays clean", (setting) => {
    const root = fixture();
    syncSkills(root);
    init(root);
    git(root, "add", ".");
    git(root, "commit", "-qm", "portable skills");
    const clone = resolve(root, "clone with spaces");
    git(root, "clone", "-q", "--no-hardlinks", "-c", `core.symlinks=${setting}`, root, clone);
    const result = syncSkills(clone);
    expect(result.changes.every((entry: { action: string }) => entry.action === "unchanged")).toBe(true);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "ls-files", "--stage", ".agents", ".claude").split("\n").every((line) => line.startsWith("100644 "))).toBe(true);
  });

  it("prepares legacy skip-worktree junctions for a clean file-to-directory commit application", () => {
    const root = fixture();
    init(root);
    git(root, "config", "core.symlinks", "false");
    write(root, ".agents/skills/example", "C:/old/toolkit/.agents/skills/example");
    write(root, ".claude/skills/example", "C:/old/toolkit/.agents/skills/example");
    git(root, "add", ".");
    for (const agent of AGENTS) {
      const path = `${agent}/skills/example`;
      const object = git(root, "hash-object", path);
      git(root, "update-index", "--cacheinfo", `120000,${object},${path}`);
    }
    git(root, "commit", "-qm", "legacy");
    const legacy = git(root, "rev-parse", "HEAD");
    syncSkills(root);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "repair");
    const repair = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "old-lane", legacy);
    for (const agent of AGENTS) {
      const path = `${agent}/skills/example`;
      rmSync(resolve(root, path));
      symlinkSync(resolve(root, "toolkit/.agents/skills/example"), resolve(root, path), process.platform === "win32" ? "junction" : "dir");
      git(root, "update-index", "--skip-worktree", "--", path);
    }
    const prepared = spawnSync(process.execPath, [resolve(REPO_ROOT, "scripts/agent-skills.mjs"), "prepare", "--project", root], { encoding: "utf8" });
    expect(prepared.stderr).toBe("");
    expect(prepared.status).toBe(0);
    expect(git(root, "ls-files", "-v", ".agents", ".claude").split("\n").every((line) => line.startsWith("H "))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
    git(root, "cherry-pick", repair);
    expect(planSkills(root).changes.every((entry: { action: string }) => entry.action === "unchanged")).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
