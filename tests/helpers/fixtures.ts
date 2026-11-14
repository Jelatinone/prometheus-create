/**
 * Load golden contract fixtures from fixtures/contracts.
 *
 * Naming: `<contract-name>.<variant>.json` validates against CONTRACTS[name].
 * Invalid cases live in `invalid/` as { expect: { path, messageIncludes }, document }.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isContractName, type ContractName } from "@/lib/contracts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const FIXTURE_DIR = resolve(REPO_ROOT, "fixtures/contracts");

export interface GoldenFixture {
  file: string;
  contract: ContractName;
  document: unknown;
}

export interface InvalidFixture extends GoldenFixture {
  expect: { path: string; messageIncludes: string };
}

function contractOf(file: string): ContractName {
  const name = file.split(".")[0];
  if (!isContractName(name)) throw new Error(`${file}: "${name}" is not a registered contract`);
  return name;
}

export function loadFixture<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), "utf8")) as T;
}

export function goldenFixtures(): GoldenFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, contract: contractOf(file), document: loadFixture(file) }));
}

export function invalidFixtures(): InvalidFixture[] {
  const dir = resolve(FIXTURE_DIR, "invalid");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const raw = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      return { file, contract: contractOf(file), document: raw.document, expect: raw.expect };
    });
}
