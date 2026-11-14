"use client";

/**
 * Capture panel (HK-002): Upload, Phone camera, Video and FaceTime sources,
 * all feeding the same CT-002 path through a CaptureIngestor. The panel knows
 * nothing about storage: the host binds the ingestor to a project and backend
 * (MemoryBackend now, the platform backend later).
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { ContractError, Result, Source } from "@/lib/contracts";
import type { CaptureIngestor, FrameOutcome, ImageOutcome } from "@/lib/capture";
import { grabVideoFrame, loadVideoMetadata, seekVideo } from "@/lib/capture/browser";

export type CaptureTab = "upload" | "camera" | "video" | "facetime";

export interface CaptureEntry {
  id: number;
  label: string;
  at: string;
  ok: boolean;
  /** Object URL of the stored upright frame (thumbnail). */
  thumbnail: string | null;
  outcome: (FrameOutcome & Partial<Pick<ImageOutcome, "registration" | "source" | "orientation">>) | null;
  error: ContractError | null;
}

export interface FaceTimeStatus {
  /** "unavailable" until a capture agent is connected for this project. */
  state: "unavailable" | "ready";
  reason: string;
}

export interface CapturePanelProps {
  ingestor: CaptureIngestor;
  faceTime?: FaceTimeStatus;
  onEntry?: (entry: CaptureEntry) => void;
}

const TABS: { id: CaptureTab; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "camera", label: "Phone camera" },
  { id: "video", label: "Video" },
  { id: "facetime", label: "FaceTime" },
];

const DEFAULT_FACETIME: FaceTimeStatus = {
  state: "unavailable",
  reason: "FaceTime capture runs in the capture agent (services/capture-agent) and is not connected to this page yet.",
};

function browserError(e: unknown): ContractError {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return { code: "UNAUTHORIZED", message: "Camera permission was denied." };
  if (name === "NotFoundError" || name === "OverconstrainedError") return { code: "NOT_FOUND", message: "No camera is available on this device." };
  if (name === "NotReadableError") return { code: "PROVIDER_UNAVAILABLE", message: "The camera is in use by another application." };
  return { code: "UNSUPPORTED_MEDIA", message: e instanceof Error ? e.message : String(e) };
}

async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function Button({ children, disabled, onClick, primary }: { children: ReactNode; disabled?: boolean; onClick?: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        primary ? "border-ink bg-ink text-canvas hover:bg-accent hover:border-accent" : "border-line bg-panel text-ink hover:text-accent hover:underline"
      }`}
    >
      {children}
    </button>
  );
}

function FilePicker({ label, accept, capture, disabled, onFile }: { label: string; accept: string; capture?: "environment"; disabled?: boolean; onFile: (f: File) => void }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 rounded border border-dashed border-line bg-panel px-3 py-2 text-sm hover:text-accent hover:underline ${disabled ? "pointer-events-none opacity-50" : ""}`}>
      <input
        type="file"
        accept={accept}
        capture={capture}
        disabled={disabled}
        className="sr-only"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      {label}
    </label>
  );
}

export function CapturePanel({ ingestor, faceTime = DEFAULT_FACETIME, onEntry }: CapturePanelProps) {
  const [tab, setTab] = useState<CaptureTab>("upload");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<CaptureEntry[]>([]);
  const nextId = useRef(1);
  const urls = useRef<string[]>([]);

  // Camera state
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const cameraSource = useRef<{ source: Source; startedAt: number; sequence: number } | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  // Video state
  const clipVideo = useRef<HTMLVideoElement>(null);
  const clip = useRef<{ source: Source; sequence: number; url: string } | null>(null);
  const [clipInfo, setClipInfo] = useState<{ name: string; durationUs: number; width: number; height: number } | null>(null);
  const [scrubUs, setScrubUs] = useState(0);

  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      if (clip.current) URL.revokeObjectURL(clip.current.url);
    },
    [],
  );

  function record(label: string, result: Result<NonNullable<CaptureEntry["outcome"]>>): CaptureEntry {
    let thumbnail: string | null = null;
    if (result.ok) {
      const { bytes, mimeType } = result.value.frame;
      thumbnail = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
      urls.current.push(thumbnail);
    }
    const entry: CaptureEntry = {
      id: nextId.current++,
      label,
      at: new Date().toLocaleTimeString(),
      ok: result.ok,
      thumbnail,
      outcome: result.ok ? result.value : null,
      error: result.ok ? null : result.error,
    };
    setEntries((list) => [entry, ...list]);
    onEntry?.(entry);
    return entry;
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }

  // ----- Upload / phone photo -----
  const ingestStill = (file: File, adapter: "upload" | "phone_camera") =>
    run(async () => {
      const result = await ingestor.ingestImage({
        bytes: await readFile(file),
        adapter,
        capturedAt: adapter === "phone_camera" ? new Date().toISOString() : null,
      });
      record(`${adapter === "upload" ? "Upload" : "Phone photo"}: ${file.name}`, result);
    });

  // ----- Live camera -----
  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      record("Camera", { ok: false, error: { code: "UNSUPPORTED_MEDIA", message: "Live camera needs HTTPS or localhost. Use “Take photo” instead." } });
      return;
    }
    await run(async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        stream.current = media;
        const video = cameraVideo.current!;
        video.srcObject = media;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        const settings = media.getVideoTracks()[0]?.getSettings();
        const started = await ingestor.startCameraSource({ width: video.videoWidth || settings?.width || null, height: video.videoHeight || settings?.height || null });
        if (!started.ok) {
          record("Camera", started);
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraSource.current = { source: started.value.source, startedAt: performance.now(), sequence: 0 };
        setCameraOn(true);
      } catch (e) {
        record("Camera", { ok: false, error: browserError(e) });
      }
    });
  }

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    cameraSource.current = null;
    if (cameraVideo.current) cameraVideo.current.srcObject = null;
    setCameraOn(false);
  }

  const captureCameraFrame = () =>
    run(async () => {
      const cam = cameraSource.current;
      const video = cameraVideo.current;
      if (!cam || !video) return;
      const frame = await grabVideoFrame(video);
      if (!frame.ok) return void record("Camera frame", frame);
      const sequence = cam.sequence++;
      const result = await ingestor.ingestFrame(cam.source, frame.value, {
        sequence,
        sourceTimeUs: Math.round((performance.now() - cam.startedAt) * 1000),
        capturedAt: new Date().toISOString(),
        mode: "evidence",
      });
      record(`Camera frame #${sequence}`, result);
    });

  // ----- Video clip -----
  const loadClip = (file: File) =>
    run(async () => {
      if (clip.current) URL.revokeObjectURL(clip.current.url);
      clip.current = null;
      setClipInfo(null);
      const bytes = await readFile(file);
      const url = URL.createObjectURL(file);
      const meta = await loadVideoMetadata(clipVideo.current!, url);
      if (!meta.ok) {
        URL.revokeObjectURL(url);
        return void record(`Video: ${file.name}`, meta);
      }
      const reg = await ingestor.registerVideo({ bytes, ...meta.value });
      if (!reg.ok) {
        URL.revokeObjectURL(url);
        return void record(`Video: ${file.name}`, reg);
      }
      clip.current = { source: reg.value.source, sequence: 0, url };
      setClipInfo({ name: file.name, ...meta.value });
      setScrubUs(0);
    });

  const captureClipFrame = () =>
    run(async () => {
      const c = clip.current;
      const video = clipVideo.current;
      if (!c || !video) return;
      const at = await seekVideo(video, scrubUs);
      if (!at.ok) return void record("Video frame", at);
      const frame = await grabVideoFrame(video);
      if (!frame.ok) return void record("Video frame", frame);
      const sequence = c.sequence++;
      const result = await ingestor.ingestFrame(c.source, frame.value, { sequence, sourceTimeUs: at.value, capturedAt: null, mode: "evidence" });
      record(`Video frame #${sequence} @ ${(at.value / 1e6).toFixed(2)}s`, result);
    });

  return (
    <section aria-label="Capture" className="rounded-lg border border-line bg-panel text-ink">
      <div role="tablist" aria-label="Capture source" className="flex flex-wrap gap-1 border-b border-line px-3 pt-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`capture-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`capture-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t border px-3 py-2 text-sm ${
              tab === t.id ? "border-line border-b-panel bg-panel font-semibold" : "border-transparent text-muted hover:text-accent hover:underline"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        <div role="tabpanel" id="capture-panel-upload" aria-labelledby="capture-tab-upload" hidden={tab !== "upload"} className="space-y-3">
          <p className="text-sm text-muted">PNG, JPEG or WebP up to 25 MB. EXIF rotation is applied so masks line up with what you see.</p>
          <FilePicker label="Choose photo…" accept="image/png,image/jpeg,image/webp" disabled={busy} onFile={(f) => ingestStill(f, "upload")} />
        </div>

        <div role="tabpanel" id="capture-panel-camera" aria-labelledby="capture-tab-camera" hidden={tab !== "camera"} className="space-y-3">
          <p className="text-sm text-muted">Live camera needs HTTPS or localhost. On a phone over plain HTTP, use Take photo.</p>
          <video ref={cameraVideo} className={`max-h-72 w-full rounded border border-line bg-panel-2 object-contain ${cameraOn ? "" : "hidden"}`} muted playsInline />
          <div className="flex flex-wrap gap-2">
            {cameraOn ? (
              <>
                <Button primary disabled={busy} onClick={captureCameraFrame}>
                  Capture frame
                </Button>
                <Button onClick={stopCamera}>Stop camera</Button>
              </>
            ) : (
              <Button disabled={busy} onClick={startCamera}>
                Start camera
              </Button>
            )}
            <FilePicker label="Take photo…" accept="image/*" capture="environment" disabled={busy} onFile={(f) => ingestStill(f, "phone_camera")} />
          </div>
        </div>

        <div role="tabpanel" id="capture-panel-video" aria-labelledby="capture-tab-video" hidden={tab !== "video"} className="space-y-3">
          <p className="text-sm text-muted">MP4, MOV or WebM up to 50 MB and 30 s. Pick the frames to keep; the clip is stored once.</p>
          <FilePicker label="Choose video…" accept="video/mp4,video/quicktime,video/webm" disabled={busy} onFile={loadClip} />
          <video ref={clipVideo} className={`max-h-72 w-full rounded border border-line bg-panel-2 object-contain ${clipInfo ? "" : "hidden"}`} muted playsInline />
          {clipInfo && (
            <div className="space-y-2">
              <label className="block text-sm">
                <span className="text-muted">
                  {clipInfo.name} · {clipInfo.width}×{clipInfo.height} · frame at {(scrubUs / 1e6).toFixed(2)} s of {(clipInfo.durationUs / 1e6).toFixed(2)} s
                </span>
                <input
                  type="range"
                  min={0}
                  max={clipInfo.durationUs}
                  step={1000}
                  value={scrubUs}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    setScrubUs(t);
                    if (clipVideo.current) void seekVideo(clipVideo.current, t);
                  }}
                  className="mt-1 block w-full accent-ink"
                />
              </label>
              <Button primary disabled={busy} onClick={captureClipFrame}>
                Use this frame
              </Button>
            </div>
          )}
        </div>

        <div role="tabpanel" id="capture-panel-facetime" aria-labelledby="capture-tab-facetime" hidden={tab !== "facetime"} className="space-y-3">
          <p className="text-sm">
            A Chert FaceTime call routes the caller&apos;s camera through the capture agent into this same ingestion path. Calls go only to a
            consenting test participant.
          </p>
          <p className={`text-sm ${faceTime.state === "ready" ? "text-ok" : "text-muted"}`} role="status">
            {faceTime.state === "ready" ? "Capture agent connected." : `Not available: ${faceTime.reason}`}
          </p>
          <Button disabled={faceTime.state !== "ready"}>Start FaceTime capture</Button>
        </div>
      </div>

      <div className="border-t border-line p-4">
        <h3 className="text-sm font-semibold">Ingested ({entries.filter((e) => e.ok).length})</h3>
        {entries.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nothing captured yet.</p>
        ) : (
          <ul className="mt-2 space-y-2" aria-live="polite">
            {entries.map((e) => (
              <li key={e.id} className="flex gap-3 rounded border border-line bg-canvas p-2 text-sm">
                {e.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local object URL of the stored frame
                  <img src={e.thumbnail} alt="" className="h-14 w-14 flex-none rounded object-cover" />
                ) : (
                  <div className="h-14 w-14 flex-none rounded bg-panel-2" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    {e.label} <span className="font-normal text-muted">· {e.at}</span>
                  </p>
                  {e.ok && e.outcome ? (
                    <p className="font-mono text-xs break-all">
                      <span className="text-ok">{e.outcome.result.status}</span> · {e.outcome.envelope.sourceId} · {e.outcome.result.observationId} · seq{" "}
                      {e.outcome.result.sequence}
                      {e.outcome.result.outOfOrder ? " · out of order" : ""} · {e.outcome.envelope.frame.width}×{e.outcome.envelope.frame.height}
                      {e.outcome.orientation && e.outcome.orientation !== 1 ? ` · EXIF ${e.outcome.orientation} normalized` : ""}
                    </p>
                  ) : (
                    <p className="font-mono text-xs text-bad">
                      {e.error?.code}: {e.error?.message}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
