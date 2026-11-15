/** Deterministic browser video: take frames, not elapsed recording time. */
import type { Rational } from "@/lib/contracts";
import type { VideoCodec } from "mediabunny";

export interface VideoFormat { extension: "mp4" | "webm"; mimeType: string; codec: VideoCodec }
export interface VideoSize { width: number; height: number }
export interface VideoProgress { completed: number; total: number }

export function videoSize(width: number, height: number): VideoSize {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale / 2) * 2), height: Math.max(2, Math.round(height * scale / 2) * 2) };
}

export function frameTiming(frame: number, rate: Rational) {
  const duration = rate.den / rate.num;
  return { timestamp: frame * duration, duration };
}

export async function supportedVideoFormat(size: VideoSize, rate: Rational): Promise<VideoFormat | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  const { canEncodeVideo, QUALITY_HIGH } = await import("mediabunny");
  const candidates: VideoFormat[] = [
    { extension: "mp4", mimeType: "video/mp4", codec: "avc" },
    { extension: "webm", mimeType: "video/webm", codec: "vp9" },
    { extension: "webm", mimeType: "video/webm", codec: "vp8" },
  ];
  for (const format of candidates) {
    if (await canEncodeVideo(format.codec, { ...size, frameRate: rate.num / rate.den, quality: QUALITY_HIGH })) return format;
  }
  return null;
}

/** A small injected frame driver makes exact timing, backpressure and cancellation testable. */
export async function writeTakeFrames(options: {
  frames: number; rate: Rational; signal?: AbortSignal;
  render(frame: number): Promise<void>;
  add(timestamp: number, duration: number): Promise<void>;
  progress?(p: VideoProgress): void;
  yield?(): Promise<void>;
}) {
  if (!Number.isSafeInteger(options.frames) || options.frames < 1) throw new Error("Enable animation before exporting a video.");
  for (let frame = 0; frame < options.frames; frame++) {
    options.signal?.throwIfAborted();
    await options.render(frame);
    options.signal?.throwIfAborted();
    const { timestamp, duration } = frameTiming(frame, options.rate);
    await options.add(timestamp, duration);
    options.progress?.({ completed: frame + 1, total: options.frames });
    if (frame % 4 === 0) await options.yield?.();
  }
  options.signal?.throwIfAborted();
}

export async function encodeVideo(options: {
  canvas: HTMLCanvasElement; format: VideoFormat; rate: Rational; frames: number; signal?: AbortSignal;
  render(frame: number): Promise<void>; progress?(p: VideoProgress): void;
}): Promise<Blob> {
  const { Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, CanvasSource, QUALITY_HIGH } = await import("mediabunny");
  const size = videoSize(options.canvas.width, options.canvas.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not create the video canvas.");
  const target = new BufferTarget();
  let bytesWritten = 0;
  target.on("write", ({ end }) => { bytesWritten = Math.max(bytesWritten, end); });
  const output = new Output({ target, format: options.format.extension === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat() });
  const source = new CanvasSource(canvas, { codec: options.format.codec, quality: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: options.rate.num / options.rate.den });
  try {
    await output.start();
    await writeTakeFrames({
      ...options,
      render: async (frame) => {
        await options.render(frame);
        context.drawImage(options.canvas, 0, 0, size.width, size.height);
      },
      add: async (timestamp, duration) => {
        await source.add(timestamp, duration);
        if (bytesWritten > 96 * 1024 * 1024) throw new Error("This video exceeds the in-browser download size. Shorten the take and try again.");
      },
      yield: () => new Promise(resolve => setTimeout(resolve, 0)),
    });
    await output.finalize();
    options.signal?.throwIfAborted();
    if (!target.buffer?.byteLength) throw new Error("The video encoder produced no output.");
    return new Blob([target.buffer], { type: options.format.mimeType });
  } catch (error) {
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
    throw error;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
