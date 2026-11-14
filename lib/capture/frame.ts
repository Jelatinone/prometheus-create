/**
 * Orientation-normalized frames.
 *
 * A capture keeps its original bytes (the source asset) and, when the original
 * carries an EXIF rotation, a separate re-encoded frame whose stored pixels are
 * already upright at the displayed size. Frames, masks and source dimensions
 * then share one pixel grid, so lasso/mask coordinates map 1:1 onto pixels.
 */
import { err, ok, sha256, type Result } from "@/lib/contracts";
import { probeImage, sniffMediaType, isImageMimeType, type ImageMimeType, type ImageProbe } from "./probe";

export interface EncodedFrame {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  /** Stored pixel size; equals the displayed size (no pending rotation). */
  width: number;
  height: number;
}

export interface HashedFrame extends EncodedFrame {
  contentHash: string;
}

/**
 * Decodes an image with its EXIF orientation applied and re-encodes it upright.
 * The browser implementation is `canvasEncoder` in ./browser.
 */
export interface FrameEncoder {
  reorient(bytes: Uint8Array, probe: ImageProbe): Promise<Result<EncodedFrame>>;
}

export interface PreparedImage {
  probe: ImageProbe;
  original: { bytes: Uint8Array; mimeType: ImageMimeType; contentHash: string };
  frame: HashedFrame;
  /** True when the original bytes are already the upright frame (stored once). */
  frameIsOriginal: boolean;
}

export async function hashFrame(frame: EncodedFrame): Promise<HashedFrame> {
  return { ...frame, contentHash: await sha256(frame.bytes) };
}

/**
 * Check that encoder output really is an upright still at the expected size.
 * Guards against silent fallbacks (e.g. a browser emitting PNG for WebP).
 */
export function checkEncodedFrame(frame: EncodedFrame, expected?: { width: number; height: number }): Result<EncodedFrame> {
  const probe = probeImage(frame.bytes);
  if (!probe.ok) return probe;
  if (probe.value.mimeType !== frame.mimeType)
    return err("UNSUPPORTED_MEDIA", `encoder labeled ${frame.mimeType} but produced ${probe.value.mimeType}`);
  if (probe.value.orientation !== 1)
    return err("UNSUPPORTED_MEDIA", "encoded frame still carries an EXIF rotation");
  if (probe.value.width !== frame.width || probe.value.height !== frame.height)
    return err("UNSUPPORTED_MEDIA", `encoded frame is ${probe.value.width}x${probe.value.height}, labeled ${frame.width}x${frame.height}`);
  if (expected && (frame.width !== expected.width || frame.height !== expected.height))
    return err(
      "UNSUPPORTED_MEDIA",
      `normalized frame is ${frame.width}x${frame.height}, expected ${expected.width}x${expected.height}`,
    );
  return ok(frame);
}

/**
 * Probe, hash and (if rotated) normalize a still image. Without an encoder a
 * rotated image is rejected rather than stored with misaligned dimensions.
 */
export async function prepareImage(bytes: Uint8Array, encoder?: FrameEncoder): Promise<Result<PreparedImage>> {
  const probed = probeImage(bytes);
  if (!probed.ok) return probed;
  const probe = probed.value;
  const original = { bytes, mimeType: probe.mimeType, contentHash: await sha256(bytes) };
  if (probe.orientation === 1) {
    return ok({
      probe,
      original,
      frame: { bytes, mimeType: probe.mimeType, width: probe.width, height: probe.height, contentHash: original.contentHash },
      frameIsOriginal: true,
    });
  }
  if (!encoder)
    return err("UNSUPPORTED_MEDIA", `image has EXIF orientation ${probe.orientation}; no orientation encoder is available here`);
  const encoded = await encoder.reorient(bytes, probe);
  if (!encoded.ok) return encoded;
  const checked = checkEncodedFrame(encoded.value, { width: probe.width, height: probe.height });
  if (!checked.ok) return checked;
  return ok({ probe, original, frame: await hashFrame(checked.value), frameIsOriginal: false });
}

/** MIME type of raw frame bytes, or null if not a supported still. */
export function frameMimeType(bytes: Uint8Array): ImageMimeType | null {
  const type = sniffMediaType(bytes);
  return isImageMimeType(type) ? type : null;
}
