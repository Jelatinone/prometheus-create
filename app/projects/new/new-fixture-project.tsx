"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ApiError,
  FIXTURE_GLB_URL,
  createFixtureProject,
  type ApiCall,
  type FixtureFlowResult,
} from "@/lib/platform/fixture-project";
import { supabaseBrowser } from "@/lib/platform/supabase-browser";

export function NewFixtureProject() {
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FixtureFlowResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setCalls([]);
    setResult(null);
    setFailure(null);
    try {
      const glb = new Uint8Array(await (await fetch(FIXTURE_GLB_URL)).arrayBuffer());
      const done = await createFixtureProject(
        {
          fetch: (input, init) => fetch(input, init),
          upload: async (target, bytes, contentType) => {
            const { error } = await supabaseBrowser()
              .storage.from(target.bucket)
              .uploadToSignedUrl(target.path, target.token, new Blob([bytes as BlobPart], { type: contentType }), {
                contentType,
              });
            if (error) throw new Error(`storage upload failed: ${error.message}`);
          },
          onCall: (call) => setCalls((prev) => [...prev, call]),
        },
        glb,
      );
      setResult(done);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded bg-ink px-4 py-2 font-medium text-canvas hover:bg-accent disabled:opacity-60"
      >
        {busy ? "Creating…" : "Create axis-box fixture project"}
      </button>
      {calls.length > 0 && (
        <ol className="mt-6 space-y-1 font-mono text-sm" aria-label="API calls">
          {calls.map((call, i) => (
            <li key={i}>
              <span className={call.status < 300 ? "text-ok" : "text-bad"}>{call.status}</span> {call.method}{" "}
              {call.path} — {call.step}
            </li>
          ))}
        </ol>
      )}
      {failure && (
        <p role="alert" className="mt-4 text-sm text-bad">
          {failure}
        </p>
      )}
      {result && (
        <div role="status" className="mt-6 rounded border border-line bg-panel p-4 text-sm">
          <p>
            Project <code>{result.projectId}</code> saved at revision <strong>{result.saved.revision}</strong> (
            <code>{result.saved.revisionId}</code>).
          </p>
          <p className="mt-1 font-mono text-xs text-muted">{result.saved.manifestHash}</p>
          <Link href="/projects" className="mt-3 inline-block underline hover:text-accent">
            Open my projects
          </Link>
        </div>
      )}
    </div>
  );
}
