"use client";

/**
 * Source tab of the right pane: the captured frame the selected object came
 * from, with its source time (µs on the capture's own clock). Source time is
 * never take time; a take reaches it only through a source mapping.
 */
import { useEffect, useState } from "react";
import type { Actor, Observation } from "@/lib/contracts";
import type { SceneObject } from "@/lib/contracts/scene";
import type { TakeManifest } from "@/lib/contracts/revision";
import { formatMicroseconds } from "@/lib/editor/timeline";
import type { HttpBackend } from "@/lib/platform/http-backend";
import { LoadingOverlay } from "@/components/ui/Loading";

export function SourcePane({ api, actor, projectId, manifest, selected }: {
  api: HttpBackend;
  actor: NonNullable<Actor>;
  projectId: string;
  manifest: TakeManifest;
  selected: SceneObject | null;
}) {
  const observationId = selected?.provenance.observationIds[0] ?? null;
  const [loaded, setLoaded] = useState<{ id: string; observation: Observation | null; url: string | null } | null>(null);

  useEffect(() => {
    if (!observationId) return;
    let live = true;
    void (async () => {
      const frames = await api.request<Observation[]>(actor, "GET", `/api/reconstruction/frames?projectId=${projectId}`);
      const observation = frames.ok ? frames.value.find((o) => o.id === observationId) ?? null : null;
      const download = observation ? await api.assetDownload(actor, projectId, observation.frame.assetId) : null;
      if (live) setLoaded({ id: observationId, observation, url: download?.ok ? download.value.download?.url ?? null : null });
    })();
    return () => {
      live = false;
    };
  }, [api, actor, projectId, observationId]);

  const current = loaded?.id === observationId ? loaded : null;
  const mappings = manifest.take.sourceMappings;
  return (
    <div className="space-y-3 text-sm">
      {!selected ? (
        <p className="text-xs text-muted">Select an object to see the captured frame it came from.</p>
      ) : !observationId ? (
        <p className="text-xs text-muted">{selected.name} was not made from a captured frame ({selected.provenance.kind}).</p>
      ) : (
        <div>
          <div className="relative grid min-h-40 place-items-center overflow-hidden rounded-lg bg-black">
            {/* Signed private asset URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {current?.url && <img src={current.url} alt={`Captured frame for ${selected.name}`} className="max-h-64 w-full object-contain" />}
            {current && !current.url && <span className="p-3 text-xs text-canvas">The captured frame is not available.</span>}
            <LoadingOverlay show={!current} />
          </div>
          {current?.observation && (
            <dl className="mt-2 text-xs">
              {(
                [
                  ["Object", selected.name],
                  ["Frame", `#${current.observation.sequence} · ${current.observation.frame.width}×${current.observation.frame.height}`],
                  ["Source time", formatMicroseconds(current.observation.sourceTimeUs)],
                  ["Provenance", `${selected.provenance.kind}${selected.provenance.provider ? ` · ${selected.provenance.provider}` : ""}`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-panel-2 py-1">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate text-right" title={v}>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      <div className="text-xs">
        <div className="font-semibold">Source mappings in this take</div>
        {mappings.length === 0 ? (
          <p className="text-muted">None. Take time is the editor&apos;s own clock; no captured clip plays inside this take.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {mappings.map((m, i) => (
              <li key={i} className="font-mono">frames {m.takeInFrame}–{m.takeOutFrame} ← source {formatMicroseconds(m.sourceInUs)} ×{m.rate}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
