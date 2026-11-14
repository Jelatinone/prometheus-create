/**
 * Regenerate lib/contracts/json-schema/*.schema.json (npm run contracts:schema).
 * tests/contracts/json-schema.test.ts fails when these files are stale.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contractJsonSchemaFiles } from "../lib/contracts/json-schema";

const dir = resolve(import.meta.dirname, "../lib/contracts/json-schema");
mkdirSync(dir, { recursive: true });
const files = contractJsonSchemaFiles();
for (const existing of readdirSync(dir)) {
  if (existing.endsWith(".schema.json") && !(existing in files)) rmSync(resolve(dir, existing));
}
for (const [name, text] of Object.entries(files)) writeFileSync(resolve(dir, name), text);
console.log(`wrote ${Object.keys(files).length} schemas to ${dir}`);
