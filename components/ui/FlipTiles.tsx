/**
 * Quiet animated backdrop: a grid of tiles that flip at scattered moments to a
 * muted, greyed tone of the accent and back. Pure CSS (see `.flip-tile` in
 * globals.css); the timings are derived from the tile index so the server and
 * the browser render the same markup. Decorative only.
 */
const TILES = 480;

/** A stable pseudo-random number in [0, 1) for a tile and a salt. */
function scatter(index: number, salt: number): number {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function FlipTiles() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="grid auto-rows-[5rem] grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-px">
        {Array.from({ length: TILES }, (_, i) => {
          const duration = 16 + scatter(i, 1) * 20; // 16 to 36 s per cycle (slower, calmer)
          return (
            <span
              key={i}
              className="flip-tile"
              style={{ animationDuration: `${duration.toFixed(2)}s`, animationDelay: `${(-scatter(i, 2) * duration).toFixed(2)}s` }}
            />
          );
        })}
      </div>
      {/* Keeps the middle calm so the form stays the focus. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-canvas)_0%,color-mix(in_srgb,var(--color-canvas)_70%,transparent)_38%,transparent_75%)]" />
    </div>
  );
}
