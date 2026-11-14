"use client";

import { useMemo, useState } from "react";
import type { FixtureEntry } from "@/fixtures";
import { parseContract, type ValidationIssue } from "@/lib/contracts/common";
import { CONTRACTS, CONTRACT_NAMES, isContractName, type ContractName } from "@/lib/contracts/registry";

type Outcome =
  | { state: "empty" }
  | { state: "not-json"; message: string }
  | { state: "valid" }
  | { state: "invalid"; issues: ValidationIssue[] };

function guessContract(fileName: string): ContractName | null {
  const prefix = fileName.split(/[\\/]/).pop()?.split(".")[0] ?? "";
  return isContractName(prefix) ? prefix : null;
}

export function ContractValidator({ examples }: { examples: FixtureEntry[] }) {
  const [contract, setContract] = useState<ContractName>("take-manifest");
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);

  const outcome = useMemo<Outcome>(() => {
    if (!text.trim()) return { state: "empty" };
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return { state: "not-json", message: (e as Error).message };
    }
    const result = parseContract(CONTRACTS[contract].schema, doc);
    if (result.ok) return { state: "valid" };
    return { state: "invalid", issues: (result.error.details?.issues ?? []) as ValidationIssue[] };
  }, [text, contract]);

  async function loadFile(file: File) {
    const guessed = guessContract(file.name);
    if (guessed) setContract(guessed);
    setText(await file.text());
  }

  function loadExample(file: string) {
    const entry = examples.find((e) => e.file === file);
    if (!entry) return;
    setContract(entry.contract);
    setText(JSON.stringify(entry.document, null, 2));
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-muted">Contract</span>
            <select
              value={contract}
              onChange={(e) => setContract(e.target.value as ContractName)}
              className="mt-1 rounded-md border border-line bg-panel px-2 py-1.5"
            >
              {CONTRACT_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name} ({CONTRACTS[name].contract})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-muted">Load an example</span>
            <select
              value=""
              onChange={(e) => loadExample(e.target.value)}
              className="mt-1 rounded-md border border-line bg-panel px-2 py-1.5"
            >
              <option value="">Choose a fixture…</option>
              {examples.map((e) => (
                <option key={e.file} value={e.file}>
                  {e.file}
                  {e.expect ? " (invalid case)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="cursor-pointer rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:border-accent">
            Open file…
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
            />
          </label>
        </div>
        <textarea
          aria-label="JSON document"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) loadFile(file);
          }}
          spellCheck={false}
          placeholder="Paste JSON here, or drop a .json file"
          className={`h-[28rem] w-full rounded-lg border bg-panel p-3 font-mono text-xs leading-relaxed ${
            dragging ? "border-accent" : "border-line"
          }`}
        />
      </div>
      <aside aria-live="polite" className="rounded-lg border border-line bg-panel p-4 text-sm">
        <h2 className="font-medium">Result</h2>
        <p className="mt-1 text-xs text-muted">{CONTRACTS[contract].description}</p>
        {outcome.state === "empty" && <p className="mt-4 text-muted">Waiting for a document.</p>}
        {outcome.state === "not-json" && (
          <p className="mt-4 text-bad">✗ Not valid JSON: {outcome.message}</p>
        )}
        {outcome.state === "valid" && (
          <p className="mt-4 font-medium text-ok">✓ Valid {contract}</p>
        )}
        {outcome.state === "invalid" && (
          <div className="mt-4">
            <p className="font-medium text-bad">
              ✗ {outcome.issues.length} issue{outcome.issues.length === 1 ? "" : "s"}
            </p>
            <ul className="mt-2 space-y-2">
              {outcome.issues.map((issue, i) => (
                <li key={i} className="rounded border border-line bg-panel-2 p-2">
                  <div className="font-mono text-xs text-accent">{issue.path}</div>
                  <div className="mt-0.5">{issue.message}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
