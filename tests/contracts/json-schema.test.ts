import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contractJsonSchemaFiles } from "@/lib/contracts/json-schema";
import { REPO_ROOT } from "../helpers/fixtures";

const dir = resolve(REPO_ROOT, "lib/contracts/json-schema");

describe("generated JSON Schemas are current (run `npm run contracts:schema` if this fails)", () => {
  const expected = contractJsonSchemaFiles();

  it.each(Object.keys(expected))("%s", (file) => {
    const path = resolve(dir, file);
    expect(existsSync(path), `${file} missing`).toBe(true);
    expect(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).toBe(expected[file]);
  });

  it("has no stale schema files", () => {
    const actual = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
    expect(actual.sort()).toEqual(Object.keys(expected).sort());
  });
});
