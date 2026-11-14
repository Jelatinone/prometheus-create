import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS, parseContract, sha256, type Asset, type ValidationIssue } from "@/lib/contracts";
import { REPO_ROOT, goldenFixtures, invalidFixtures, loadFixture } from "../helpers/fixtures";

describe("golden fixtures validate against their contract", () => {
  it.each(goldenFixtures().map((f) => [f.file, f] as const))("%s", (_file, fixture) => {
    const result = parseContract(CONTRACTS[fixture.contract].schema, fixture.document);
    expect(result.ok ? [] : result.error.details?.issues).toEqual([]);
  });
});

describe("invalid fixtures fail at the expected path", () => {
  it.each(invalidFixtures().map((f) => [f.file, f] as const))("%s", (_file, fixture) => {
    const result = parseContract(CONTRACTS[fixture.contract].schema, fixture.document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.error.details?.issues as ValidationIssue[];
    const match = issues.find(
      (i) => i.path === fixture.expect.path && i.message.includes(fixture.expect.messageIncludes),
    );
    expect(match, JSON.stringify(issues, null, 2)).toBeDefined();
  });
});

describe("fixture assets", () => {
  it("axis-box.glb matches the hash and size recorded in asset.axis-box.json", async () => {
    const asset = loadFixture<Asset>("asset.axis-box.json");
    const bytes = readFileSync(resolve(REPO_ROOT, "public/fixtures/axis-box.glb"));
    expect(bytes.byteLength).toBe(asset.byteSize);
    expect(await sha256(bytes)).toBe(asset.contentHash);
  });

  it("every registered contract has at least one golden fixture or is response-only", () => {
    const covered = new Set(goldenFixtures().map((f) => f.contract));
    const responseOnly = new Set([
      "project",
      "scene-document",
      "take-document",
      "observation",
      "ingest-result",
      "revision",
      "save-revision-response",
      "create-project-request",
      "create-project-response",
      "fork-take-request",
      "fork-take-response",
      "take-summary",
      "export-manifest",
      "contract-error",
      "source-registration",
    ]);
    const missing = Object.keys(CONTRACTS).filter((n) => !covered.has(n as never) && !responseOnly.has(n));
    expect(missing).toEqual([]);
  });
});
