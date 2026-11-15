/**
 * The one loading treatment used everywhere: a light overlay that dims what is
 * underneath, with an accent-coloured spinner, fading in and out. Never a
 * "Loading…" sentence.
 */
export function Spinner({ className = "size-8" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-[3px] border-line border-t-accent ${className}`}
    />
  );
}

/** Covers its positioned parent while `show` is true; fades out (300 ms) when it turns false. */
export function LoadingOverlay({ show, className = "" }: { show: boolean; className?: string }) {
  return (
    <div
      aria-hidden={!show}
      aria-busy={show}
      className={`absolute inset-0 z-20 grid place-items-center bg-canvas/60 transition-opacity duration-300 ${
        show ? "opacity-100" : "pointer-events-none opacity-0"
      } ${className}`}
    >
      <Spinner />
    </div>
  );
}

/** Full-screen version for route-level waits (Suspense fallbacks). */
export function LoadingScreen({ stage = false }: { stage?: boolean }) {
  return (
    <div className={`fixed inset-0 z-30 ${stage ? "bg-stage" : "bg-canvas"}`}>
      <LoadingOverlay show />
    </div>
  );
}
