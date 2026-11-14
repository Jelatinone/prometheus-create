/**
 * CaptureIngestor: one path from any capture adapter into CT-002.
 *
 *   bytes -> BlobStore -> AssetCatalog.putAsset -> IngestionGateway.registerSource
 *         -> IngestionGateway.ingest(IngestEnvelope)
 *
 * Upload, phone camera and video adapters differ only in how they obtain an
 * upright frame; the records they emit are identical in shape. The ingestor
 * depends on the ports only, so MemoryBackend and the platform backend are
 * interchangeable.
 */
import {
  INGEST_LIMITS,
  IngestEnvelope,
  SourceRegistration,
  checkFrameLimits,
  checkSourceLimits,
  err,
  newId,
  ok,
  parseContract,
  type Actor,
  type Asset,
  type AssetCatalog,
  type AssetKind,
  type IngestResult,
  type IngestionGateway,
  type Rational,
  type Result,
  type Source,
} from "@/lib/contracts";
import { storeProjectAsset } from "./assets";
import type { BlobStore } from "./blob-store";
import { prepareImage, hashFrame, checkEncodedFrame, type EncodedFrame, type FrameEncoder } from "./frame";
import { sniffMediaType, isVideoMimeType } from "./probe";

export type CaptureAdapter = "upload" | "phone_camera";

export interface CaptureDeps {
  assets: AssetCatalog;
  ingestion: IngestionGateway;
  blobs: BlobStore;
  actor: Actor;
  projectId: string;
  /** Re-encodes EXIF-rotated stills; the browser passes `canvasEncoder`. */
  encoder?: FrameEncoder;
  now?: () => Date;
}

export interface FrameOutcome {
  envelope: IngestEnvelope;
  result: IngestResult;
  frameAsset: Asset;
}

export interface ImageOutcome extends FrameOutcome {
  registration: SourceRegistration;
  source: Source;
  sourceAsset: Asset;
  /** EXIF orientation of the original (1 = already upright). */
  orientation: number;
}

export interface FrameOptions {
  sequence: number;
  sourceTimeUs: number;
  capturedAt: string | null;
  mode: "evidence" | "preview";
}

export class CaptureIngestor {
  private readonly now: () => Date;

  constructor(private readonly deps: CaptureDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get projectId(): string {
    return this.deps.projectId;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /** Store bytes, then record the asset. Idempotent for identical content. */
  storeAsset(
    bytes: Uint8Array,
    meta: { kind: AssetKind; mimeType: string; origin: Asset["origin"]; contentHash?: string },
  ): Promise<Result<Asset>> {
    return storeProjectAsset(this.deps, this.deps.projectId, bytes, meta);
  }

  private async register(reg: SourceRegistration): Promise<Result<Source>> {
    const parsed = parseContract(SourceRegistration, reg);
    if (!parsed.ok) return parsed;
    return this.deps.ingestion.registerSource(this.deps.actor, parsed.value);
  }

  private consent(adapter: CaptureAdapter | "fixture", note: string | null = null) {
    return {
      basis: adapter === "fixture" ? ("fixture" as const) : ("owner_upload" as const),
      recordedAt: this.timestamp(),
      note,
    };
  }

  /**
   * A single still (file picker upload or a phone camera photo): register an
   * image source and ingest its one frame (sequence 0 at 0µs).
   */
  async ingestImage(input: {
    bytes: Uint8Array;
    adapter: CaptureAdapter;
    capturedAt?: string | null;
    consentNote?: string | null;
    sourceId?: string;
  }): Promise<Result<ImageOutcome>> {
    const prepared = await prepareImage(input.bytes, this.deps.encoder);
    if (!prepared.ok) return prepared;
    const { probe, original, frame, frameIsOriginal } = prepared.value;
    const media = { kind: "image" as const, mimeType: probe.mimeType, width: probe.width, height: probe.height };
    const limits = checkSourceLimits({ media }, input.bytes.byteLength);
    if (!limits.ok) return limits;

    const sourceAsset = await this.storeAsset(original.bytes, {
      kind: "image",
      mimeType: original.mimeType,
      origin: "upload",
      contentHash: original.contentHash,
    });
    if (!sourceAsset.ok) return sourceAsset;
    const frameAsset = frameIsOriginal
      ? sourceAsset
      : await this.storeAsset(frame.bytes, { kind: "frame", mimeType: frame.mimeType, origin: "capture", contentHash: frame.contentHash });
    if (!frameAsset.ok) return frameAsset;

    const registration: SourceRegistration = {
      schemaVersion: 1,
      id: input.sourceId ?? newId("source"),
      projectId: this.deps.projectId,
      adapter: input.adapter,
      media,
      assetId: sourceAsset.value.id,
      contentHash: original.contentHash,
      capturedAt: input.capturedAt ?? null,
      captureSessionId: null,
      consent: this.consent(input.adapter, input.consentNote ?? null),
    };
    const source = await this.register(registration);
    if (!source.ok) return source;
    const ingested = await this.submitFrame(source.value, frameAsset.value, frame, {
      sequence: 0,
      sourceTimeUs: 0,
      capturedAt: input.capturedAt ?? null,
      mode: "evidence",
    });
    if (!ingested.ok) return ingested;
    return ok({
      ...ingested.value,
      registration,
      source: source.value,
      sourceAsset: sourceAsset.value,
      orientation: probe.orientation,
    });
  }

  /**
   * Register an uploaded clip. Width/height are the displayed (post-rotation)
   * size and duration comes from the decoder (`<video>` metadata in browsers).
   */
  async registerVideo(input: {
    bytes: Uint8Array;
    width: number;
    height: number;
    durationUs: number;
    nominalFrameRate?: Rational | null;
    capturedAt?: string | null;
    sourceId?: string;
  }): Promise<Result<{ registration: SourceRegistration; source: Source; sourceAsset: Asset }>> {
    const mimeType = sniffMediaType(input.bytes);
    if (!isVideoMimeType(mimeType))
      return err("UNSUPPORTED_MEDIA", mimeType ? `${mimeType} is not a video` : "not an MP4, QuickTime or WebM video", {
        allowed: INGEST_LIMITS.videoSourceMimeTypes,
      });
    const media = {
      kind: "video" as const,
      mimeType,
      width: input.width,
      height: input.height,
      durationUs: Math.max(1, Math.round(input.durationUs)),
      nominalFrameRate: input.nominalFrameRate ?? null,
    };
    const limits = checkSourceLimits({ media }, input.bytes.byteLength);
    if (!limits.ok) return limits;
    const sourceAsset = await this.storeAsset(input.bytes, { kind: "video", mimeType, origin: "upload" });
    if (!sourceAsset.ok) return sourceAsset;
    const registration: SourceRegistration = {
      schemaVersion: 1,
      id: input.sourceId ?? newId("source"),
      projectId: this.deps.projectId,
      adapter: "upload",
      media,
      assetId: sourceAsset.value.id,
      contentHash: sourceAsset.value.contentHash,
      capturedAt: input.capturedAt ?? null,
      captureSessionId: null,
      consent: this.consent("upload"),
    };
    const source = await this.register(registration);
    if (!source.ok) return source;
    return ok({ registration, source: source.value, sourceAsset: sourceAsset.value });
  }

  /** A live phone-camera session: frames arrive as observations, no stored clip. */
  async startCameraSource(input: { width: number | null; height: number | null; sourceId?: string }): Promise<
    Result<{ registration: SourceRegistration; source: Source }>
  > {
    const registration: SourceRegistration = {
      schemaVersion: 1,
      id: input.sourceId ?? newId("source"),
      projectId: this.deps.projectId,
      adapter: "phone_camera",
      media: { kind: "live_stream", width: input.width, height: input.height },
      assetId: null,
      contentHash: null,
      capturedAt: this.timestamp(),
      captureSessionId: null,
      consent: this.consent("phone_camera"),
    };
    const source = await this.register(registration);
    if (!source.ok) return source;
    return ok({ registration, source: source.value });
  }

  /** Ingest one upright frame of a registered video or live source. */
  async ingestFrame(source: Source, frame: EncodedFrame, options: FrameOptions): Promise<Result<FrameOutcome>> {
    const checked = checkEncodedFrame(frame);
    if (!checked.ok) return checked;
    const hashed = await hashFrame(checked.value);
    const asset = await this.storeAsset(hashed.bytes, {
      kind: "frame",
      mimeType: hashed.mimeType,
      origin: "capture",
      contentHash: hashed.contentHash,
    });
    if (!asset.ok) return asset;
    return this.submitFrame(source, asset.value, hashed, options);
  }

  private async submitFrame(
    source: Source,
    frameAsset: Asset,
    frame: EncodedFrame & { contentHash: string },
    options: FrameOptions,
  ): Promise<Result<FrameOutcome>> {
    const envelope: IngestEnvelope = {
      schemaVersion: 1,
      projectId: this.deps.projectId,
      sourceId: source.id,
      adapter: source.adapter,
      captureSessionId: source.captureSessionId,
      sequence: options.sequence,
      sourceTimeUs: Math.max(0, Math.round(options.sourceTimeUs)),
      capturedAt: options.capturedAt,
      mode: options.mode,
      frame: {
        assetId: frameAsset.id,
        mimeType: frame.mimeType,
        byteSize: frame.bytes.byteLength,
        width: frame.width,
        height: frame.height,
        contentHash: frame.contentHash,
      },
    };
    const parsed = parseContract(IngestEnvelope, envelope);
    if (!parsed.ok) return parsed;
    const limits = checkFrameLimits(parsed.value);
    if (!limits.ok) return limits;
    const result = await this.deps.ingestion.ingest(this.deps.actor, parsed.value);
    if (!result.ok) return result;
    return ok({ envelope: parsed.value, result: result.value, frameAsset });
  }
}
