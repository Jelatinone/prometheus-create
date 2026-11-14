/**
 * Clock conversions (PLAN §4 "Scene state, source time, and take time").
 * Source time: integer µs. Take time: integer frames at a rational rate.
 */
import type { Rational } from "./common";
import type { SourceMapping } from "./scene";

export const DEFAULT_TAKE_FRAME_RATE: Rational = { num: 30, den: 1 };
/** New playback takes default to five seconds. */
export const DEFAULT_TAKE_SECONDS = 5;

/** Start time of a take frame in µs (rounded to the nearest µs). */
export function frameToMicroseconds(frame: number, rate: Rational): number {
  return Math.round((frame * rate.den * 1_000_000) / rate.num);
}

/** The take frame displayed at a time in µs (floor). */
export function microsecondsToFrame(us: number, rate: Rational): number {
  return Math.floor((us * rate.num) / (rate.den * 1_000_000) + 1e-9);
}

/**
 * Source presentation time shown at a take frame for one mapping, or null
 * outside [takeInFrame, takeOutFrame). rate 0 holds a single source frame.
 *   t_source = sourceIn + rate * (t_take - takeIn)
 */
export function sourceTimeAtTakeFrame(
  mapping: SourceMapping,
  frame: number,
  takeRate: Rational,
): number | null {
  if (frame < mapping.takeInFrame || frame >= mapping.takeOutFrame) return null;
  const elapsedUs = frameToMicroseconds(frame - mapping.takeInFrame, takeRate);
  return mapping.sourceInUs + Math.round(mapping.rate * elapsedUs);
}

/** The mapping active at a take frame (last one wins if they overlap). */
export function activeMapping(
  mappings: readonly SourceMapping[],
  frame: number,
): SourceMapping | null {
  let found: SourceMapping | null = null;
  for (const m of mappings) {
    if (frame >= m.takeInFrame && frame < m.takeOutFrame) found = m;
  }
  return found;
}
