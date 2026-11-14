/**
 * Dependency-free media sniffing for capture inputs.
 *
 * File names and browser-reported MIME types are hints only; the bytes decide.
 * probeImage reports the encoded pixel size, the JPEG EXIF orientation, and the
 * post-orientation (displayed) size that sources, frames and masks must use
 * (CT-002: masks align to the source's post-orientation pixel grid).
 */
import { err, ok, type Result } from "@/lib/contracts";

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type VideoMimeType = "video/mp4" | "video/quicktime" | "video/webm";

export interface ImageProbe {
  mimeType: ImageMimeType;
  /** Pixel size as stored in the file, before EXIF orientation. */
  encodedWidth: number;
  encodedHeight: number;
  /** EXIF orientation 1-8; 1 when absent or not applicable. */
  orientation: number;
  /** Post-orientation (displayed) size: the source/frame/mask pixel grid. */
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Identify a supported image or video container from its first bytes. */
export function sniffMediaType(bytes: Uint8Array): ImageMimeType | VideoMimeType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 4) === "ftyp") return ascii(bytes, 8, 4) === "qt  " ? "video/quicktime" : "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "video/webm";
  return null;
}

export function isImageMimeType(type: string | null): type is ImageMimeType {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}

export function isVideoMimeType(type: string | null): type is VideoMimeType {
  return type === "video/mp4" || type === "video/quicktime" || type === "video/webm";
}

/** Orientations 5-8 rotate by 90°/270°, swapping width and height. */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

function readExifOrientation(bytes: Uint8Array, start: number, end: number): number {
  // start points at "Exif\0\0"; TIFF header follows.
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const order = ascii(bytes, tiff, 2);
  const little = order === "II";
  if (!little && order !== "MM") return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function probeJpeg(bytes: Uint8Array): Result<Omit<ImageProbe, "mimeType" | "width" | "height">> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return err("UNSUPPORTED_MEDIA", `corrupt JPEG: no marker at byte ${offset}`);
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const segment = offset + 4;
    const segmentEnd = offset + 2 + length;
    if (length < 2 || segmentEnd > bytes.length) return err("UNSUPPORTED_MEDIA", "corrupt JPEG: segment overruns file");
    if (marker === 0xe1 && ascii(bytes, segment, 6) === "Exif\0\0") {
      orientation = readExifOrientation(bytes, segment, segmentEnd);
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (segment + 5 > bytes.length) return err("UNSUPPORTED_MEDIA", "corrupt JPEG: short frame header");
      const encodedHeight = view.getUint16(segment + 1);
      const encodedWidth = view.getUint16(segment + 3);
      return ok({ encodedWidth, encodedHeight, orientation });
    }
    if (marker === 0xda || marker === 0xd9) break; // scan data / end without a frame header
    offset = segmentEnd;
  }
  return err("UNSUPPORTED_MEDIA", "JPEG has no frame header (SOF)");
}

function probeWebp(bytes: Uint8Array): Result<{ encodedWidth: number; encodedHeight: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return err("UNSUPPORTED_MEDIA", "corrupt WebP: missing VP8 start code");
    return ok({ encodedWidth: view.getUint16(26, true) & 0x3fff, encodedHeight: view.getUint16(28, true) & 0x3fff });
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    if (bytes[20] !== 0x2f) return err("UNSUPPORTED_MEDIA", "corrupt WebP: missing VP8L signature");
    const bits = view.getUint32(21, true);
    return ok({ encodedWidth: (bits & 0x3fff) + 1, encodedHeight: ((bits >> 14) & 0x3fff) + 1 });
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return ok({ encodedWidth: w + 1, encodedHeight: h + 1 });
  }
  return err("UNSUPPORTED_MEDIA", `unsupported WebP chunk "${chunk}"`);
}

/**
 * Sniff and measure a PNG, JPEG or WebP. Other bytes are UNSUPPORTED_MEDIA.
 * Only JPEG EXIF orientation is read; PNG/WebP are treated as orientation 1
 * (the browser normalizer trusts its decoded bitmap size over this probe).
 */
export function probeImage(bytes: Uint8Array): Result<ImageProbe> {
  const mimeType = sniffMediaType(bytes);
  if (!isImageMimeType(mimeType))
    return err("UNSUPPORTED_MEDIA", mimeType ? `${mimeType} is not a still image` : "not a PNG, JPEG or WebP image", {
      allowed: ["image/png", "image/jpeg", "image/webp"],
    });
  let measured: Result<{ encodedWidth: number; encodedHeight: number; orientation?: number }>;
  if (mimeType === "image/png") {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return err("UNSUPPORTED_MEDIA", "corrupt PNG: no IHDR");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    measured = ok({ encodedWidth: view.getUint32(16), encodedHeight: view.getUint32(20) });
  } else if (mimeType === "image/jpeg") {
    measured = probeJpeg(bytes);
  } else {
    measured = probeWebp(bytes);
  }
  if (!measured.ok) return measured;
  const { encodedWidth, encodedHeight } = measured.value;
  if (encodedWidth <= 0 || encodedHeight <= 0) return err("UNSUPPORTED_MEDIA", "image has zero width or height");
  const orientation = measured.value.orientation ?? 1;
  const swap = orientationSwapsAxes(orientation);
  return ok({
    mimeType,
    encodedWidth,
    encodedHeight,
    orientation,
    width: swap ? encodedHeight : encodedWidth,
    height: swap ? encodedWidth : encodedHeight,
  });
}
