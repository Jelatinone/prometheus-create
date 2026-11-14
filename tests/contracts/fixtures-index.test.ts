import { describe, expect, it } from "vitest";
import { GOLDEN_FIXTURES, INVALID_FIXTURES } from "@/fixtures";
import { goldenFixtures, invalidFixtures } from "../helpers/fixtures";

describe("fixtures/index.ts lists every fixture file", () => {
  it("golden", () => {
    expect(GOLDEN_FIXTURES.map((f) => f.file).sort()).toEqual(goldenFixtures().map((f) => f.file).sort());
  });
  it("invalid", () => {
    expect(INVALID_FIXTURES.map((f) => f.file.replace("invalid/", "")).sort()).toEqual(
      invalidFixtures().map((f) => f.file).sort(),
    );
  });
});
