"use client";

import { useEffect, useState } from "react";
import { PhoneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { Actor } from "@/lib/contracts";
import type { HttpBackend } from "@/lib/platform/http-backend";
import { Presence } from "@/components/ui/Presence";
import { Spinner } from "@/components/ui/Loading";

type CallState = { state: "idle" | "calling" | "building" | "done" | "failed"; message: string; projectId?: string; at: number };

/**
 * Start a FaceTime capture (demo machine). Every call spends real API usage, so
 * it asks for the server's access code first, like the first-visit usage notice.
 */
export function FaceTimeModal({ open, onClose, api, actor, projectId, onSceneReady }: {
  open: boolean;
  onClose(): void;
  api: HttpBackend;
  actor: NonNullable<Actor>;
  projectId: string;
  /** Called when a scene splat was added to the take (reload to see it). */
  onSceneReady(): void;
}) {
  const [code, setCode] = useState("");
  const [sceneSplat, setSceneSplat] = useState(true);
  const [detail, setDetail] = useState<"light" | "standard" | "dense">("standard");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<CallState | null>(null);
  const running = status?.state === "calling" || status?.state === "building";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const r = await api.request<CallState>(actor, "GET", "/api/capture/call");
      if (r.ok) setStatus(r.value);
    }, 3000);
    return () => clearInterval(timer);
  }, [running, api, actor]);

  async function start() {
    setSending(true);
    setError("");
    const r = await api.request<CallState>(actor, "POST", "/api/capture/call", { projectId, code: code.trim(), sceneSplat, detail });
    setSending(false);
    if (!r.ok) return setError(r.error.message);
    setStatus(r.value);
  }

  return (
    <Presence show={open} enter="animate-fade" className="fixed inset-0 z-[90] grid place-items-center bg-ink/30 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="facetime-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md animate-pop overflow-y-auto rounded-xl border border-line bg-panel p-6 text-ink shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="facetime-title" className="font-serif text-2xl font-semibold">Start FaceTime</h2>
          <button className="text-muted hover:text-accent" onClick={onClose} aria-label="Close" title="Close">
            <XMarkIcon className="size-5" />
          </button>
        </div>
        {!status ? (
          <>
            <p className="mt-3 text-sm leading-relaxed">
              A FaceTime call uses several <span className="font-semibold text-accent">paid</span> services, so it needs the access code from the person running this demo.
              The call lasts about 35 seconds; slowly sweep the room while it records.
            </p>
            <label className="mt-4 block text-sm font-medium" htmlFor="facetime-code">Access code</label>
            <input
              id="facetime-code"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) void start(); }}
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 focus:border-accent focus:outline-none"
            />
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={sceneSplat} onChange={(e) => setSceneSplat(e.target.checked)} />
              <span>
                Build a scene splat after the call
                <span className="block text-xs text-muted">Walls and floor as the camera saw them, from all call frames (extra paid step; can take a few minutes).</span>
              </span>
            </label>
            {sceneSplat && (
              <label className="mt-3 flex items-center justify-between gap-3 text-sm">
                Scene detail
                <select value={detail} onChange={(e) => setDetail(e.target.value as typeof detail)} className="h-8 rounded-lg border border-line bg-canvas px-2 text-sm" aria-label="Scene detail">
                  <option value="light">Light (fastest, phones)</option>
                  <option value="standard">Standard</option>
                  <option value="dense">Dense (sharper, slower)</option>
                </select>
              </label>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
            <button
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2 font-medium text-canvas hover:bg-accent disabled:cursor-not-allowed disabled:bg-muted"
              disabled={!code.trim() || sending}
              onClick={() => void start()}
            >
              {sending ? <Spinner className="size-4" /> : <PhoneIcon className="size-5" />}
              Start FaceTime
            </button>
          </>
        ) : (
          <div className="mt-4 space-y-4 text-sm" role="status">
            <p className={`flex items-start gap-2 ${status.state === "failed" ? "text-bad" : ""}`}>
              {running && <Spinner className="mt-0.5 size-4 shrink-0" />}
              {status.message}
            </p>
            {status.state === "done" && sceneSplat && (
              <button className="w-full rounded-lg bg-ink px-4 py-2 font-medium text-canvas hover:bg-accent" onClick={onSceneReady}>Reload take</button>
            )}
            {!running && <button className="w-full rounded-lg border border-line px-4 py-2 hover:text-accent" onClick={() => { setStatus(null); onClose(); }}>Close</button>}
          </div>
        )}
      </div>
    </Presence>
  );
}
