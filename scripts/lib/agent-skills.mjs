// Portable native entrypoints; canonical workflow bodies stay in the pinned toolkit.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const AGENTS = [".agents", ".claude"];
const MARKER = /<!-- hackathon-toolkit-adapter:v1 sha256=([a-f0-9]{64}) -->/;
const ZERO = "0".repeat(64);
const lf = (text) => text.replace(/\r\n/g, "\n");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const stat = (path) => {
  try { return lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

function directory(path) {
  const info = stat(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`Expected an ordinary directory, refusing to follow or replace: ${path}`);
  }
  return info;
}

export function renderAdapter(name, frontmatter) {
  const body = `${frontmatter}\n\n<!-- hackathon-toolkit-adapter:v1 sha256=${ZERO} -->\n\n# ${name}\n\nRead and follow the [Canonical workflow](../../../toolkit/.agents/skills/${name}/SKILL.md) before acting.\n\nKeep this checkout (three directories above this file) as the project root for project files, commands, and Git operations. Resolve links inside the canonical workflow relative to that workflow's file in the toolkit. Follow the toolkit's PROJECT_CONTRACT.md and FORMATS.md, along with this project's AGENTS.md and approved records.\n\nIf the canonical file is missing, initialize the pinned submodule from the project root with \`git submodule update --init --recursive\`, then read it. Shared project tools are listed in AGENTS.md and package.json; run them from the project root.\n`;
  return body.replace(ZERO, hash(body));
}

export function intactAdapter(text) {
  const normalized = lf(text);
  const match = normalized.match(MARKER);
  return !!match && hash(normalized.replace(match[1], ZERO)) === match[1];
}

// Old links may point at the base checkout, not this worktree. Only unlink the
// link itself; never traverse or delete its target, even when the target is stale.
export function legacyTarget(target, name) {
  const normalized = target.trim().replace(/\\/g, "/").replace(/\/$/, "");
  return !/[\r\n]/.test(normalized)
    && /^(?:[A-Za-z]:\/|\/|(?:\.\.?\/)+)/.test(normalized)
    && normalized.endsWith(`/toolkit/.agents/skills/${name}`);
}

export function planSkills(project) {
  const root = resolve(project);
  const source = resolve(root, "toolkit/.agents/skills");
  if (!directory(source)) throw new Error("Toolkit skills are missing. Run git submodule update --init --recursive from the project root.");
  const names = readdirSync(source).sort();
  if (!names.length) throw new Error(`No canonical skills found: ${source}`);
  const canonical = names.map((name) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid canonical skill name: ${name}`);
    directory(resolve(source, name));
    const text = lf(readFileSync(resolve(source, name, "SKILL.md"), "utf8"));
    const frontmatter = text.match(/^---\nname: ("[^\n]+")\ndescription: ("[^\n]+")\n---/);
    if (!frontmatter || JSON.parse(frontmatter[1]) !== name || typeof JSON.parse(frontmatter[2]) !== "string") {
      throw new Error(`Invalid canonical frontmatter: ${name}`);
    }
    return { name, content: renderAdapter(name, frontmatter[0]) };
  });
  const changes = [];
  const conflicts = [];
  for (const agent of AGENTS) {
    directory(resolve(root, agent));
    directory(resolve(root, agent, "skills"));
    for (const { name, content } of canonical) {
      const path = `${agent}/skills/${name}`;
      const absolute = resolve(root, path);
      const info = stat(absolute);
      let action = "create";
      if (info?.isSymbolicLink()) {
        if (!legacyTarget(readlinkSync(absolute), name)) conflicts.push(`${path}: unrecognized link target`);
        action = "migrate";
      } else if (info?.isFile()) {
        if (!legacyTarget(readFileSync(absolute, "utf8"), name)) conflicts.push(`${path}: user-owned file`);
        action = "migrate";
      } else if (info?.isDirectory()) {
        const entry = resolve(absolute, "SKILL.md");
        const entryInfo = stat(entry);
        if (entryInfo) {
          if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) {
            conflicts.push(`${path}/SKILL.md: not an ordinary file`);
          } else {
            const existing = lf(readFileSync(entry, "utf8"));
            if (existing === content) action = "unchanged";
            else if (intactAdapter(existing)) action = "update";
            else conflicts.push(`${path}/SKILL.md: user-owned or edited adapter`);
          }
        }
      } else if (info) conflicts.push(`${path}: unsupported filesystem entry`);
      changes.push({ path, action, content });
    }
    // A toolkit upgrade must not silently leave obsolete generated commands.
    const destination = resolve(root, agent, "skills");
    if (stat(destination)) for (const name of readdirSync(destination)) {
      if (names.includes(name)) continue;
      const path = resolve(destination, name);
      const info = stat(path);
      if (info?.isSymbolicLink() || !info?.isDirectory()) continue;
      const entry = resolve(path, "SKILL.md");
      const entryInfo = stat(entry);
      if (entryInfo?.isFile() && !entryInfo.isSymbolicLink() && MARKER.test(readFileSync(entry, "utf8"))) {
        conflicts.push(`${agent}/skills/${name}: obsolete generated adapter; review and remove explicitly`);
      }
    }
  }
  if (conflicts.length) throw new Error(`No files changed. Resolve skill conflicts:\n${conflicts.join("\n")}`);
  return { root, changes };
}

export function syncSkills(project) {
  // Preflight every entry before the first write, including both clients.
  const plan = planSkills(project);
  for (const { path, action, content } of plan.changes) {
    if (action === "unchanged") continue;
    const absolute = resolve(plan.root, path);
    if (action === "migrate") unlinkSync(absolute);
    const file = resolve(absolute, "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return plan;
}
