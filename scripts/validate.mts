/**
 * Validate JSON files against a named contract, or inspect a GLB.
 *
 *   npm run validate -- list
 *   npm run validate -- <contract-name> <file.json> [more.json...]
 *   npm run validate -- auto fixtures/contracts/*.json   (name from file prefix)
 *   npm run validate -- glb <file.glb>
 *
 * Exit code 0 when everything is valid, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { inspectGlb } from "../lib/assets/glb";
// Import leaf modules: Node cannot see re-exports of the CJS-transpiled index.
import { parseContract, type ValidationIssue } from "../lib/contracts/common";
import { CONTRACTS, isContractName } from "../lib/contracts/registry";

const [mode, ...files] = process.argv.slice(2);

function usage(): never {
  console.log("usage: npm run validate -- <contract|auto|glb|list> [files...]");
  console.log("contracts:");
  for (const [name, e] of Object.entries(CONTRACTS)) console.log(`  ${name.padEnd(24)} ${e.contract}  ${e.description}`);
  process.exit(mode === "list" ? 0 : 1);
}

if (!mode || mode === "list" || mode === "--help") usage();

let failures = 0;

if (mode === "glb") {
  for (const file of files) {
    const result = inspectGlb(readFileSync(file));
    if (!result.ok) {
      failures++;
      console.log(`FAIL ${file}: ${result.error.code} ${result.error.message}`);
      continue;
    }
    const v = result.value;
    const dims = v.dimensions?.map((d) => d.toFixed(3)).join(" x ") ?? "unknown";
    console.log(`OK   ${file}: ${dims} (file units), ${v.triangleCount} tris, ${v.meshCount} meshes, ${v.nodeCount} nodes`);
    for (const w of v.warnings) console.log(`     warning: ${w}`);
  }
} else {
  if (mode !== "auto" && !isContractName(mode)) {
    console.log(`unknown contract "${mode}"`);
    usage();
  }
  if (files.length === 0) usage();
  for (const file of files) {
    const name = mode === "auto" ? basename(file).split(".")[0] : mode;
    if (!isContractName(name)) {
      failures++;
      console.log(`FAIL ${file}: cannot infer a contract from "${name}"`);
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      failures++;
      console.log(`FAIL ${file}: not JSON (${(e as Error).message})`);
      continue;
    }
    // Invalid-case fixtures wrap the document: { expect, document }.
    const wrapped = doc as { expect?: { path: string; messageIncludes: string }; document?: unknown };
    if (wrapped && typeof wrapped === "object" && wrapped.expect && "document" in wrapped) {
      console.log(`     (invalid-case fixture; expected failure at ${wrapped.expect.path})`);
      doc = wrapped.document;
    }
    const result = parseContract(CONTRACTS[name].schema, doc);
    if (result.ok) {
      console.log(`OK   ${file} (${name})`);
    } else {
      failures++;
      console.log(`FAIL ${file} (${name})`);
      for (const issue of (result.error.details?.issues ?? []) as ValidationIssue[])
        console.log(`     ${issue.path}: ${issue.message}`);
    }
  }
}

process.exit(failures ? 1 : 0);
