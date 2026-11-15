import { describe, expect, it } from "vitest";
import { seekVideo, type SeekableVideo } from "@/lib/capture/browser";

/** A stand-in for a `<video>`: setting currentTime starts a seek that the test finishes (or not). */
class FakeVideo extends EventTarget {
  duration = 10;
  readyState = 4;
  seeking = false;
  seeks: number[] = [];
  private time = 0;
  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.seeks.push(t);
    this.seeking = true;
    this.time = t;
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listeners--;
    super.removeEventListener(...args);
  }
}
const asVideo = (v: FakeVideo) => v as unknown as SeekableVideo;

describe("seekVideo", () => {
  it("seeks to a different time and reports the decoded time in microseconds", async () => {
    const v = new FakeVideo();
    const first = seekVideo(asVideo(v), 2_500_000);
    v.finishSeek();
    expect(await first).toEqual({ ok: true, value: 2_500_000 });
    const second = seekVideo(asVideo(v), 7_250_000);
    v.finishSeek();
    expect(await second).toEqual({ ok: true, value: 7_250_000 });
    expect(v.seeks).toEqual([2.5, 7.25]);
    expect(v.listeners).toBe(0); // nothing left attached
  });

  it("resolves at once when that frame is already shown (no event to wait for)", async () => {
    const v = new FakeVideo();
    const first = seekVideo(asVideo(v), 3_000_000);
    v.finishSeek();
    await first;
    expect(await seekVideo(asVideo(v), 3_000_000)).toEqual({ ok: true, value: 3_000_000 });
    expect(v.seeks).toEqual([3]); // the repeat did not seek again
  });

  it("waits for a seek that is still in flight to the same time", async () => {
    const v = new FakeVideo();
    void seekVideo(asVideo(v), 4_000_000); // scrubbing started this seek
    let settled = false;
    const again = seekVideo(asVideo(v), 4_000_000).then((r) => ((settled = true), r));
    await Promise.resolve();
    expect(settled).toBe(false);
    v.finishSeek();
    expect(await again).toEqual({ ok: true, value: 4_000_000 });
  });

  it("clamps to the clip and never hangs: not loaded, decode error and timeout all settle", async () => {
    const v = new FakeVideo();
    const end = seekVideo(asVideo(v), 99_000_000);
    v.finishSeek();
    expect(await end).toEqual({ ok: true, value: 10_000_000 });

    const unloaded = new FakeVideo();
    unloaded.readyState = 0;
    expect(await seekVideo(asVideo(unloaded), 1_000_000)).toMatchObject({ ok: false, error: { code: "NO_FRESH_FRAME" } });

    const broken = new FakeVideo();
    const failing = seekVideo(asVideo(broken), 1_000_000);
    broken.dispatchEvent(new Event("error"));
    expect(await failing).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_MEDIA" } });
    expect(broken.listeners).toBe(0);

    const stuck = new FakeVideo();
    expect(await seekVideo(asVideo(stuck), 1_000_000, 20)).toMatchObject({ ok: false, error: { code: "NO_FRESH_FRAME" } });
    expect(stuck.listeners).toBe(0);
  });
});
