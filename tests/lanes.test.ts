import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, globToRegExp, matchesAny } from "../scripts/lib/lanes.mjs";
import lanes from "@/lanes.json";
import { REPO_ROOT } from "./helpers/fixtures";

type Lanes = typeof lanes;
const classifyFor = (path: string, lane: keyof Lanes["lanes"]) =>
  (classify as (p: string, l: string, all: Lanes) => string)(path, lane, lanes);

describe("lane globs", () => {
  it("treat Next.js [brackets] literally and ** as any depth", () => {
    const re = (globToRegExp as (g: string) => RegExp)("app/projects/[projectId]/**");
    expect(re.test("app/projects/[projectId]/page.tsx")).toBe(true);
    expect(re.test("app/projects/[projectId]/edit/page.tsx")).toBe(true);
    expect(re.test("app/projects/p/page.tsx")).toBe(false);
    expect(re.test("app/projects/page.tsx")).toBe(false);
  });

  it("keeps both agents' tracked skills visible to the shared-path ownership check", () => {
    for (const agent of [".agents", ".claude"]) {
      const path = `${agent}/skills/kickoff-project/SKILL.md`;
      expect((matchesAny as (p: string, g: string[]) => boolean)(path, lanes.ignore)).toBe(false);
      expect(classifyFor(path, "track-b")).toBe("shared");
    }
    expect((matchesAny as (p: string, g: string[]) => boolean)(".claude/launch.json", lanes.ignore)).toBe(false);
  });

  it("classify owned, dependency, contract, other-lane and shared paths", () => {
    expect(classifyFor("components/editor/Viewport.tsx", "track-b")).toBe("owned");
    expect(classifyFor("package-lock.json", "track-b")).toBe("dependency");
    expect(classifyFor("lib/contracts/scene.ts", "track-b")).toBe("contract");
    expect(classifyFor("db/migrations/001.sql", "track-b")).toBe("other-lane:platform");
    expect(classifyFor("app/layout.tsx", "track-a")).toBe("shared");
    expect(classifyFor("services/capture-agent/agent.py", "track-a")).toBe("owned");
  });

  it("no path is owned by two lanes", () => {
    const owners = Object.entries(lanes.lanes).flatMap(([key, lane]) => lane.owns.map((g) => [g, key]));
    const samples = owners.map(([g]) => g.replace("/**", "/x.ts"));
    for (const sample of samples) {
      const claimants = Object.keys(lanes.lanes).filter(
        (key) => classifyFor(sample, key as keyof Lanes["lanes"]) === "owned",
      );
      expect(claimants, sample).toHaveLength(1);
    }
  });
});

describe("lanes.json agrees with PLAN.md", () => {
  const plan = readFileSync(resolve(REPO_ROOT, "PLAN.md"), "utf8");
  it.each(Object.entries(lanes.lanes))("%s lane task and branch appear in the PLAN task registry", (_key, lane) => {
    const row = plan.split("\n").find((line) => line.startsWith(`| ${lane.task} |`));
    expect(row, `${lane.task} row missing from PLAN.md section 5`).toBeDefined();
    expect(row).toContain(`| ${lane.branch} |`);
  });
});
