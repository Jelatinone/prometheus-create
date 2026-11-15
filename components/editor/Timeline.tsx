"use client";

/**
 * The take timeline (CP-013), shown in the Playback pop-up: play/pause, a frame scrubber with the
 * selected object's keys, take time, and source time shown separately (only
 * when a source mapping covers the playhead). Scrubbing is local: it changes
 * what the viewport shows and never calls a provider.
 */
import { BackwardIcon, FilmIcon, KeyIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import type { Rational } from "@/lib/contracts/common";
import { formatMicroseconds, formatTakeTime } from "@/lib/editor/timeline";

interface Props {
  rate: Rational;
  durationFrames: number;
  playhead: number;
  playing: boolean;
  /** Source time at the playhead, or null when no mapping covers it. */
  sourceUs: number | null;
  /** Keys of the selected object (empty when nothing is selected or it is not animated). */
  keys: number[];
  canKey: boolean;
  keyTarget?: "camera" | "object";
  onPlay(playing: boolean): void;
  onSeek(frame: number): void;
  onAnimate(): void;
  onToggleKey(): void;
}

export function Timeline({ rate, durationFrames, playhead, playing, sourceUs, keys, canKey, keyTarget = "object", onPlay, onSeek, onAnimate, onToggleKey }: Props) {
  const icon = "grid size-8.5 place-items-center rounded-lg text-ink hover:bg-panel-2 hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink";
  const still = durationFrames <= 0;
  const last = Math.max(0, durationFrames - 1);
  const onKey = keys.includes(playhead);
  return (
    <div className="flex h-12 w-full items-center gap-2 rounded-xl border border-line bg-panel px-2 shadow-sm" role="group" aria-label="Timeline">
      <button className={icon} onClick={() => onSeek(0)} disabled={still} title="Go to start (Home)" aria-label="Go to start">
        <BackwardIcon className="size-5" />
      </button>
      <button className={icon} onClick={() => onPlay(!playing)} disabled={still} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing}>
        {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5" />}
      </button>
      {still ? (
        <>
          <span className="text-sm text-muted">Still take: one frame.</span>
          <button className="ml-auto flex h-8.5 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-panel-2 hover:text-accent" onClick={onAnimate} title="Enable playback; edit duration in the Camera pane">
            <FilmIcon className="size-5" />
            Animate
          </button>
        </>
      ) : (
        <>
          <span className="w-36 shrink-0 font-mono text-xs tabular-nums" title="Take time (frames at the take rate)" data-testid="take-time">
            {formatTakeTime(playhead, rate)} <span className="text-muted">/ {formatTakeTime(durationFrames, rate)}</span>
            <span className="block text-[10px] text-muted">frame {playhead}</span>
          </span>
          <div className="relative min-w-0 flex-1">
            {keys.map((k) => (
              <span
                key={k}
                className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-accent"
                style={{ left: `${(k / Math.max(1, last)) * 100}%` }}
                aria-hidden
              />
            ))}
            <input
              type="range"
              min={0}
              max={last}
              step={1}
              value={Math.min(playhead, last)}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="relative w-full accent-[var(--color-accent)]"
              aria-label="Playhead (take frame)"
            />
          </div>
          <span className="w-28 shrink-0 text-right font-mono text-xs tabular-nums" title="Source time comes from a source mapping, never from take time" data-testid="source-time">
            <span className="block text-[10px] text-muted">source</span>
            {sourceUs === null ? <span className="text-muted">none mapped</span> : formatMicroseconds(sourceUs)}
          </span>
          <button
            className={`${icon} ${onKey ? "text-accent" : ""}`}
            onClick={onToggleKey}
            disabled={!canKey}
            title={!canKey ? `Select a ${keyTarget} to key it` : onKey ? `Remove this ${keyTarget} key (K)` : `Set a ${keyTarget} key from the current pose (K)`}
            aria-label={onKey ? "Remove key" : "Set key"}
            aria-pressed={onKey}
          >
            <KeyIcon className="size-5" />
          </button>
        </>
      )}
    </div>
  );
}
