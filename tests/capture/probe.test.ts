import { describe, expect, it } from "vitest";
import { orientationSwapsAxes, probeImage, sniffMediaType } from "@/lib/capture";
import { captureFixture, codeOf, expectOk } from "./helpers";

describe("probeImage", () => {
  it("measures PNG, baseline JPEG, lossy and lossless WebP from bytes", () => {
    for (const [file, type] of [
      ["upright-64x48.png", "image/png"],
      ["upright-64x48.jpg", "image/jpeg"],
      ["lossy-64x48.webp", "image/webp"],
      ["lossless-64x48.webp", "image/webp"],
    ] as const) {
      const p = expectOk(probeImage(captureFixture(file)));
      expect(p, file).toMatchObject({ mimeType: type, encodedWidth: 64, encodedHeight: 48, orientation: 1, width: 64, height: 48 });
    }
  });

  it("reads EXIF orientation 6 and reports the displayed (swapped) size", () => {
    const p = expectOk(probeImage(captureFixture("rotated-orientation6.jpg")));
    expect(p).toMatchObject({ encodedWidth: 64, encodedHeight: 48, orientation: 6, width: 48, height: 64 });
  });

  it("rejects non-images and truncated files as UNSUPPORTED_MEDIA", () => {
    expect(codeOf(probeImage(new TextEncoder().encode("hello, not an image")))).toBe("UNSUPPORTED_MEDIA");
    const jpeg = captureFixture("upright-64x48.jpg");
    expect(codeOf(probeImage(jpeg.subarray(0, 40)))).toBe("UNSUPPORTED_MEDIA");
    const png = captureFixture("upright-64x48.png");
    expect(codeOf(probeImage(png.subarray(0, 12)))).toBe("UNSUPPORTED_MEDIA");
  });

  it("names a video passed as a still", () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0]);
    const r = probeImage(mp4);
    expect(codeOf(r)).toBe("UNSUPPORTED_MEDIA");
    expect(!r.ok && r.error.message).toContain("video/mp4");
  });
});

describe("sniffMediaType", () => {
  it("identifies video containers by signature, not file name", () => {
    const enc = (s: string) => [...new TextEncoder().encode(s)];
    expect(sniffMediaType(new Uint8Array([0, 0, 0, 20, ...enc("ftypqt  ")]))).toBe("video/quicktime");
    expect(sniffMediaType(new Uint8Array([0, 0, 0, 20, ...enc("ftypmp42")]))).toBe("video/mp4");
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("video/webm");
    expect(sniffMediaType(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("knows which orientations swap axes", () => {
    expect([1, 2, 3, 4].map(orientationSwapsAxes)).toEqual([false, false, false, false]);
    expect([5, 6, 7, 8].map(orientationSwapsAxes)).toEqual([true, true, true, true]);
  });
});
