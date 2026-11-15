import { describe, expect, it } from "vitest";
import { frameTiming, videoSize, writeTakeFrames } from "@/lib/export/video";

describe("offline take video timing", () => {
  it("keeps arbitrary duration and rational timestamps despite slow rendering/encoding", async () => {
    const rate = { num: 30000, den: 1001 };
    let rendering = -1;
    let inFlight = false;
    const stamps: number[] = [];
    await writeTakeFrames({ frames: 211, rate,
      render: async frame => { expect(inFlight).toBe(false); rendering = frame; await Promise.resolve(); },
      add: async (time, duration) => {
        expect(time).toBeCloseTo(rendering * 1001 / 30000, 10);
        expect(duration).toBeCloseTo(1001 / 30000, 10);
        inFlight = true; await Promise.resolve(); inFlight = false; stamps.push(time);
      },
    });
    expect(stamps).toHaveLength(211);
    expect(stamps.at(-1)! + frameTiming(0, rate).duration).toBeCloseTo(211 * 1001 / 30000, 10);
  });

  it("stops after cancellation or a rendering failure rather than silently skipping a frame", async () => {
    const abort = new AbortController();
    const frames: number[] = [];
    await expect(writeTakeFrames({ frames: 90, rate: { num: 30, den: 1 }, signal: abort.signal,
      render: async frame => { frames.push(frame); if (frame === 3) abort.abort(); }, add: async () => {},
    })).rejects.toThrow();
    expect(frames).toEqual([0, 1, 2, 3]);
    let written = 0;
    await expect(writeTakeFrames({ frames: 90, rate: { num: 30, den: 1 }, render: async frame => { if (frame === 2) throw new Error("frame unavailable"); }, add: async () => { written++; } })).rejects.toThrow("frame unavailable");
    expect(written).toBe(2);
  });

  it("uses bounded even output dimensions for browser codecs", () => {
    expect(videoSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(videoSize(1001, 703)).toEqual({ width: 1002, height: 704 });
    expect(videoSize(720, 1280)).toEqual({ width: 720, height: 1280 });
  });
});
