import { describe, expect, it } from "vitest";
import { TakeManifest } from "@/lib/contracts";
import { eulerDegToQuat, findObject } from "@/lib/editor/model";
import { defaultDurationFrames, evaluateAt, formatMicroseconds, formatTakeTime, keyFrames, removeKey, setDuration, setKey, sourceAt } from "@/lib/editor/timeline";
import { loadFixture } from "../helpers/fixtures";

const BOX = "obj_fixture_axis_box";
const still = () => loadFixture<TakeManifest>("take-manifest.original.json");
const valid = (m: TakeManifest) => {
  const r = TakeManifest.safeParse(m);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return true;
};

describe("take clocks", () => {
  it("formats take time from frames at the rational rate, and source time from µs", () => {
    expect(formatTakeTime(0, { num: 30, den: 1 })).toBe("00:00.00");
    expect(formatTakeTime(75, { num: 30, den: 1 })).toBe("00:02.50");
    expect(formatTakeTime(30, { num: 30000, den: 1001 })).toBe("00:01.00"); // 29.97 fps: 1.001 s
    expect(formatMicroseconds(61_250_000)).toBe("01:01.25");
    expect(defaultDurationFrames({ num: 30, den: 1 })).toBe(150);
  });

  it("source time comes only from a mapping; without one there is none", () => {
    const m = setDuration(still(), 150);
    expect(sourceAt(m, 40)).toBeNull();
    m.take.sourceMappings = [{ sourceId: "src_fixture_upload", takeInFrame: 30, takeOutFrame: 90, sourceInUs: 12_000_000, rate: 1 }];
    expect(sourceAt(m, 40)).toEqual({ sourceId: "src_fixture_upload", us: 12_333_333 });
    expect(sourceAt(m, 10)).toBeNull();
    expect(valid(m)).toBe(true);
  });
});

describe("keys and evaluation", () => {
  it("a still take becomes a 5 s take; keys interpolate position, rotation and scale; outside keys hold", () => {
    let m = setDuration(still(), defaultDurationFrames(still().take.frameRate));
    expect(m.take.durationFrames).toBe(150);
    const base = findObject(m, BOX)!.transform;
    m = setKey(m, BOX, 0, base);
    m = setKey(m, BOX, 100, { position: [1, 0.45, 0], rotation: eulerDegToQuat([0, 90, 0]), scale: [2, 2, 2] });
    expect(valid(m)).toBe(true);
    expect(keyFrames(m, BOX)).toEqual([0, 100]);

    const mid = findObject(evaluateAt(m, 50), BOX)!.transform;
    expect(mid.position[0]).toBeCloseTo(0.5);
    expect(mid.scale).toEqual([1.5, 1.5, 1.5]);
    const half = eulerDegToQuat([0, 45, 0]);
    mid.rotation.forEach((v, i) => expect(v).toBeCloseTo(half[i], 6));
    expect(findObject(evaluateAt(m, 140), BOX)!.transform.position).toEqual([1, 0.45, 0]); // after the last key: hold
    // The base transform is untouched; evaluation copies, never edits.
    expect(findObject(m, BOX)!.transform).toEqual(base);
  });

  it("step keys hold until the next key; replacing and removing keys keeps the manifest valid", () => {
    let m = setDuration(still(), 150);
    m = setKey(m, BOX, 10, { ...findObject(m, BOX)!.transform, position: [0, 0.45, 0] }, "step");
    m = setKey(m, BOX, 60, { ...findObject(m, BOX)!.transform, position: [0, 0.45, 2] });
    expect(findObject(evaluateAt(m, 59), BOX)!.transform.position).toEqual([0, 0.45, 0]);
    m = setKey(m, BOX, 60, { ...findObject(m, BOX)!.transform, position: [0, 0.45, 3] }); // replace
    expect(keyFrames(m, BOX)).toEqual([10, 60]);
    m = removeKey(m, BOX, 10);
    expect(keyFrames(m, BOX)).toEqual([60]);
    m = removeKey(m, BOX, 60); // last key: track removed, its pose becomes the base
    expect(m.take.tracks).toHaveLength(0);
    expect(findObject(m, BOX)!.transform.position).toEqual([0, 0.45, 3]);
    expect(valid(m)).toBe(true);
  });

  it("keys need a playback take, and durations never cut existing tracks", () => {
    expect(setKey(still(), BOX, 0, findObject(still(), BOX)!.transform)).toEqual(still()); // still take: no keys
    let m = setDuration(still(), 150);
    m = setKey(m, BOX, 120, findObject(m, BOX)!.transform);
    expect(setDuration(m, 60).take.durationFrames).toBe(150); // cannot cut the track
    const longer = setDuration(m, 300);
    expect(longer.take.tracks[0].endFrame).toBe(300); // the object's track follows the take
    expect(valid(longer)).toBe(true);
    expect(setKey(m, BOX, 150, findObject(m, BOX)!.transform)).toBe(m); // outside [0, duration)
  });
});
