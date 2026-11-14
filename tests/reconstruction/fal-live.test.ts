/** Offline checks for the live fal adapter's guards (no network, no key use). */
import { describe, expect, it } from "vitest";
import { createLiveFalQueue, falKeyFromEnv, isFalOrigin } from "@/lib/reconstruction/fal-live";
import { FalQueueError } from "@/lib/reconstruction";

describe("fal live adapter guards", () => {
  it("reads FAL_KEY first and falls back to FAL_API_KEY", () => {
    expect(falKeyFromEnv({ FAL_KEY: "a", FAL_API_KEY: "b" })).toBe("a");
    expect(falKeyFromEnv({ FAL_API_KEY: "b" })).toBe("b");
    expect(falKeyFromEnv({})).toBeUndefined();
  });

  it("rejects a masked placeholder copied from a dashboard", () => {
    expect(() => falKeyFromEnv({ FAL_API_KEY: "•".repeat(32) })).toThrow(FalQueueError);
  });

  it("refuses to start without a key", () => {
    expect(() => createLiveFalQueue("")).toThrow(/not set/);
  });

  it("downloads provider outputs only from https fal origins", async () => {
    expect(isFalOrigin("https://v3b.fal.media/files/b/x/mesh.glb")).toBe(true);
    expect(isFalOrigin("https://fal.media/files/x.glb")).toBe(true);
    expect(isFalOrigin("http://v3b.fal.media/x.glb")).toBe(false);
    expect(isFalOrigin("https://fal.media.evil.example/x.glb")).toBe(false);
    expect(isFalOrigin("https://169.254.169.254/latest")).toBe(false);
    const fal = createLiveFalQueue("dummy-key-not-used");
    await expect(fal.download("https://example.com/x.glb")).rejects.toThrow(/non-fal origin/);
  });
});
