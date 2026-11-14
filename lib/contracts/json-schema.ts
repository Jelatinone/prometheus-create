/**
 * JSON Schema (draft 2020-12) export of the registered contracts, for
 * non-TypeScript consumers such as the Python capture agent.
 *
 * Structural only: zod refinements (cross-field invariants such as "one
 * driver per interval" or "live streams have no asset") are not expressible
 * here. Servers always re-validate with the zod schemas.
 */
import { z } from "zod";
import { CONTRACTS, type ContractName } from "./registry";

export function contractJsonSchema(name: ContractName): Record<string, unknown> {
  const entry = CONTRACTS[name];
  const schema = z.toJSONSchema(entry.schema, { unrepresentable: "any" }) as Record<string, unknown>;
  return {
    ...schema,
    $id: `prometheus-create/contracts/${name}.schema.json`,
    title: name,
    description: `${entry.contract}: ${entry.description}. Generated from lib/contracts; do not edit.`,
  };
}

export function contractJsonSchemaFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of Object.keys(CONTRACTS) as ContractName[]) {
    files[`${name}.schema.json`] = JSON.stringify(contractJsonSchema(name), null, 2) + "\n";
  }
  return files;
}
