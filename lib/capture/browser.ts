/**
 * Browser-only capture helpers: EXIF-aware re-encoding and frame grabs from
 * `<video>` elements (uploaded clips and live camera streams).
 *
 * These touch DOM APIs only when called, so importing the module on the server
 * is safe. They are checked by hand in the dev harness; the pure logic they
 * rely on (probe, frame checks, ingestor) is unit-tested in node.
 */
import { err, ok, type Result } from "@/lib/contracts";
import { checkEncodedFrame, type EncodedFrame, type FrameEncoder } from "./frame";
import type { ImageMimeType, ImageProbe } from "./probe";

const JPEG_QUALITY = 0.92;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encodeCanvas(canvas: HTMLCanvasElement, mimeType: ImageMimeType): Promise<Result<EncodedFrame>> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mimeType, mimeType === "image/jpeg" ? JPEG_QUALITY : undefined),
  );
  if (!blob) return err("UNSUPPORTED_MEDIA", `this browser could not encode ${mimeType}`);
  const frame: EncodedFrame = {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    width: canvas.width,
    height: canvas.height,
  };
  return checkEncodedFrame(frame);
}

/** Lossy sources stay JPEG; PNG/WebP become PNG (WebP encoding is not universal). */
function outputType(input: ImageMimeType): ImageMimeType {
  return input === "image/jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Decode with EXIF orientation applied (`imageOrientation: "from-image"`) and
 * re-encode the upright pixels at the displayed size.
 */
export const canvasEncoder: FrameEncoder = {
  async reorient(bytes: Uint8Array, probe: ImageProbe): Promise<Result<EncodedFrame>> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: probe.mimeType }), {
        imageOrientation: "from-image",
      });
    } catch (e) {
      return err("UNSUPPORTED_MEDIA", `browser could not decode the image: ${(e as Error).message}`);
    }
    try {
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return err("UNSUPPORTED_MEDIA", "2D canvas unavailable");
      ctx.drawImage(bitmap, 0, 0);
      return await encodeCanvas(canvas, outputType(probe.mimeType));
    } finally {
      bitmap.close();
    }
  },
};

/**
 * Grab the frame currently shown by a `<video>` (a seeked clip or a live
 * camera stream). Browsers expose videoWidth/videoHeight post-rotation, so
 * the result is already upright.
 */
export async function grabVideoFrame(
  video: HTMLVideoElement,
  mimeType: ImageMimeType = "image/jpeg",
): Promise<Result<EncodedFrame>> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight)
    return err("NO_FRESH_FRAME", "the video has no decoded frame yet");
  const canvas = makeCanvas(video.videoWidth, video.videoHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) return err("UNSUPPORTED_MEDIA", "2D canvas unavailable");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return encodeCanvas(canvas, mimeType);
}

/** Load a clip's displayed size and duration from the browser decoder. */
export function loadVideoMetadata(
  video: HTMLVideoElement,
  url: string,
): Promise<Result<{ width: number; height: number; durationUs: number }>> {
  return new Promise((resolve) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      if (!Number.isFinite(video.duration) || video.duration <= 0)
        return resolve(err("UNSUPPORTED_MEDIA", "the browser reports no finite duration for this clip"));
      resolve(ok({ width: video.videoWidth, height: video.videoHeight, durationUs: Math.round(video.duration * 1e6) }));
    };
    const onError = () => {
      cleanup();
      resolve(err("UNSUPPORTED_MEDIA", "this browser cannot decode the clip (codec unsupported?)"));
    };
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("error", onError);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
  });
}

/** Seek a clip and resolve once the frame at `timeUs` is decoded. */
export function seekVideo(video: HTMLVideoElement, timeUs: number): Promise<Result<number>> {
  return new Promise((resolve) => {
    const target = Math.min(Math.max(0, timeUs / 1e6), video.duration);
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve(ok(Math.round(video.currentTime * 1e6)));
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = target;
  });
}
