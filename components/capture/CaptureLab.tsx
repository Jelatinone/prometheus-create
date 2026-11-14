"use client";

/**
 * Development harness for CapturePanel: an in-browser MemoryBackend project so
 * the panel can be checked by hand before the platform backend exists. Data
 * lives in this tab only and is lost on reload. The editor lane mounts
 * CapturePanel in the real project page.
 */
import { useEffect, useState } from "react";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import { CaptureIngestor, MemoryBlobStore, createCaptureProject } from "@/lib/capture";
import { canvasEncoder } from "@/lib/capture/browser";
import { CapturePanel, type CaptureEntry } from "./CapturePanel";

type LabState = { status: "starting" } | { status: "ready"; projectId: string; ingestor: CaptureIngestor } | { status: "error"; message: string };

export function CaptureLab() {
  const [lab, setLab] = useState<LabState>({ status: "starting" });
  const [last, setLast] = useState<CaptureEntry | null>(null);

  useEffect(() => {
    let live = true;
    const backend = new MemoryBackend();
    const actor = { userId: "capture-lab" };
    void createCaptureProject(backend.projects, actor, "Capture lab").then((created) => {
      if (!live) return;
      if (!created.ok) return setLab({ status: "error", message: `${created.error.code}: ${created.error.message}` });
      const projectId = created.value.project.id;
      const ingestor = new CaptureIngestor({
        assets: backend.assets,
        ingestion: backend.ingestion,
        blobs: new MemoryBlobStore(),
        actor,
        projectId,
        encoder: canvasEncoder,
      });
      setLab({ status: "ready", projectId, ingestor });
    });
    return () => {
      live = false;
    };
  }, []);

  if (lab.status === "starting") return <p className="text-sm text-muted">Creating an in-memory project…</p>;
  if (lab.status === "error") return <p className="text-sm text-bad">Could not start the lab: {lab.message}</p>;

  const records = last?.outcome
    ? { ...(last.outcome.registration ? { sourceRegistration: last.outcome.registration } : {}), ingestEnvelope: last.outcome.envelope, ingestResult: last.outcome.result }
    : null;

  return (
    <div className="space-y-4">
      <p className="rounded border border-line bg-panel-2 px-3 py-2 text-sm">
        <strong>Development harness.</strong> In-memory backend (project <code className="font-mono text-xs">{lab.projectId}</code>); nothing is
        saved and a reload starts over.
      </p>
      <CapturePanel ingestor={lab.ingestor} onEntry={setLast} />
      {records && (
        <details className="rounded border border-line bg-panel p-3 text-sm" open>
          <summary className="cursor-pointer font-semibold">Last CT-002 records (validate with npm run validate)</summary>
          <pre className="mt-2 max-h-96 overflow-auto font-mono text-xs" data-testid="capture-records">
            {JSON.stringify(records, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
