/**
 * CaptureIngestor against the MemoryBackend reference (CT-002). Inputs are the
 * generated, labeled test images in fixtures/capture; mocks prove plumbing and
 * error paths, never a live capture.
 */
import { describe, expect, it } from "vitest";
import { CONTRACTS, parseContract, sha256, type Result } from "@/lib/contracts";
import { assetStorageKey, frameMimeType, probeImage, type EncodedFrame, type FrameEncoder } from "@/lib/capture";
import { captureFixture, captureHarness, codeOf, expectOk } from "./helpers";

/** Encoder stand-in that returns Pillow's exif_transpose output for the rotated fixture. */
const pillowUpright: FrameEncoder = {
  async reorient(): Promise<Result<EncodedFrame>> {
    const bytes = captureFixture("rotated-orientation6.upright.png");
    return { ok: true, value: { bytes, mimeType: "image/png", width: 48, height: 64 } };
  },
};

function frameOf(file: string): EncodedFrame {
  const bytes = captureFixture(file);
  const probe = expectOk(probeImage(bytes));
  return { bytes, mimeType: probe.mimeType, width: probe.width, height: probe.height };
}

const mp4Header = () =>
  new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0, ...new Uint8Array(64)]);

describe("CaptureIngestor: image upload", () => {
  it("registers an upright PNG and ingests its single frame through the gateway", async () => {
    const h = await captureHarness();
    const bytes = captureFixture("upright-64x48.png");
    const out = expectOk(await h.ingestor.ingestImage({ bytes, adapter: "upload" }));

    expect(out.result).toMatchObject({ status: "accepted", sequence: 0, outOfOrder: false, latestSequence: 0 });
    expect(out.source.media).toEqual({ kind: "image", mimeType: "image/png", width: 64, height: 48 });
    expect(out.source.contentHash).toBe(await sha256(bytes));
    // Upright original is stored once and reused as the frame.
    expect(out.frameAsset.id).toBe(out.sourceAsset.id);
    expect(out.envelope.frame).toMatchObject({ width: 64, height: 48, mimeType: "image/png", byteSize: bytes.byteLength });

    // Records satisfy the published contracts (what `npm run validate` checks).
    expect(parseContract(CONTRACTS["source-registration"].schema, out.registration).ok).toBe(true);
    expect(parseContract(CONTRACTS["ingest-envelope"].schema, out.envelope).ok).toBe(true);

    // Bytes landed in storage under the asset's private key.
    const stored = expectOk(await h.blobs.get(assetStorageKey(h.projectId, out.sourceAsset.id)));
    expect(await sha256(stored.bytes)).toBe(out.sourceAsset.contentHash);

    const latest = expectOk(await h.backend.ingestion.latestObservation(h.actor, h.projectId, out.source.id));
    expect(latest.id).toBe(out.result.observationId);
    expect(latest.frame.contentHash).toBe(out.envelope.frame.contentHash);
  });

  it("normalizes an EXIF-rotated JPEG: displayed size on the source, separate upright frame asset", async () => {
    const h = await captureHarness({ encoder: pillowUpright });
    const out = expectOk(await h.ingestor.ingestImage({ bytes: captureFixture("rotated-orientation6.jpg"), adapter: "upload" }));
    expect(out.orientation).toBe(6);
    expect(out.source.media).toMatchObject({ kind: "image", mimeType: "image/jpeg", width: 48, height: 64 });
    expect(out.frameAsset.id).not.toBe(out.sourceAsset.id);
    expect(out.frameAsset.kind).toBe("frame");
    expect(out.sourceAsset.kind).toBe("image");
    expect(out.envelope.frame).toMatchObject({ width: 48, height: 64, mimeType: "image/png" });
  });

  it("refuses a rotated image when no orientation encoder exists, registering nothing", async () => {
    const h = await captureHarness();
    const r = await h.ingestor.ingestImage({ bytes: captureFixture("rotated-orientation6.jpg"), adapter: "upload" });
    expect(codeOf(r)).toBe("UNSUPPORTED_MEDIA");
    expect(h.blobs.size).toBe(0);
  });

  it("rejects an encoder that returns the wrong size (masks would not align)", async () => {
    const sideways: FrameEncoder = { reorient: async () => ({ ok: true, value: frameOf("upright-64x48.png") }) };
    const h = await captureHarness({ encoder: sideways });
    const r = await h.ingestor.ingestImage({ bytes: captureFixture("rotated-orientation6.jpg"), adapter: "upload" });
    expect(codeOf(r)).toBe("UNSUPPORTED_MEDIA");
  });

  it("returns UNSUPPORTED_MEDIA for non-images and TOO_LARGE for oversize stills", async () => {
    const h = await captureHarness();
    expect(codeOf(await h.ingestor.ingestImage({ bytes: new TextEncoder().encode("plain text"), adapter: "upload" }))).toBe(
      "UNSUPPORTED_MEDIA",
    );
    const png = captureFixture("upright-64x48.png");
    const huge = new Uint8Array(26 * 1024 * 1024);
    huge.set(png);
    expect(codeOf(await h.ingestor.ingestImage({ bytes: huge, adapter: "upload" }))).toBe("TOO_LARGE");
    expect(h.blobs.size).toBe(0);
  });

  it("is idempotent for a retried identical upload with the same source id", async () => {
    const h = await captureHarness();
    const bytes = captureFixture("upright-64x48.jpg");
    const first = expectOk(await h.ingestor.ingestImage({ bytes, adapter: "upload", sourceId: "src_retry_case" }));
    const again = expectOk(await h.ingestor.ingestImage({ bytes, adapter: "upload", sourceId: "src_retry_case" }));
    expect(again.result.status).toBe("duplicate");
    expect(again.result.observationId).toBe(first.result.observationId);
    expect(again.sourceAsset.id).toBe(first.sourceAsset.id);
  });
});

describe("CaptureIngestor: video frames", () => {
  async function videoSource() {
    const h = await captureHarness();
    const reg = expectOk(await h.ingestor.registerVideo({ bytes: mp4Header(), width: 64, height: 48, durationUs: 2_000_000 }));
    return { h, source: reg.source };
  }
  const at = (sequence: number, sourceTimeUs: number) => ({ sequence, sourceTimeUs, capturedAt: null, mode: "evidence" as const });

  it("registers the clip by signature and ingests selected frames with increasing sequence/time", async () => {
    const { h, source } = await videoSource();
    expect(source.media).toMatchObject({ kind: "video", mimeType: "video/mp4", durationUs: 2_000_000 });
    const a = expectOk(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), at(0, 0)));
    const b = expectOk(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.jpg"), at(1, 500_000)));
    expect(a.result.status).toBe("accepted");
    expect(b.result).toMatchObject({ status: "accepted", latestSequence: 1, outOfOrder: false });
    const list = expectOk(await h.backend.ingestion.listObservations(h.actor, h.projectId, source.id));
    expect(list.map((o) => o.sourceTimeUs)).toEqual([0, 500_000]);
  });

  it("returns the original observation for a duplicate frame and DUPLICATE for conflicting content", async () => {
    const { h, source } = await videoSource();
    const first = expectOk(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), at(1, 500_000)));
    const dup = expectOk(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), at(1, 500_000)));
    expect(dup.result).toMatchObject({ status: "duplicate", observationId: first.result.observationId });
    const conflict = await h.ingestor.ingestFrame(source, frameOf("lossy-64x48.webp"), at(1, 500_000));
    expect(codeOf(conflict)).toBe("DUPLICATE");
  });

  it("stores an out-of-order frame without moving latest backwards", async () => {
    const { h, source } = await videoSource();
    expectOk(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), at(5, 1_500_000)));
    const late = expectOk(await h.ingestor.ingestFrame(source, frameOf("lossless-64x48.webp"), at(4, 1_200_000)));
    expect(late.result).toMatchObject({ status: "accepted", outOfOrder: true, latestSequence: 5 });
    const latest = expectOk(await h.backend.ingestion.latestObservation(h.actor, h.projectId, source.id));
    expect(latest.sequence).toBe(5);
  });

  it("rejects a frame whose size differs from the clip and a frame past its duration", async () => {
    const { h, source } = await videoSource();
    expect(codeOf(await h.ingestor.ingestFrame(source, frameOf("rotated-orientation6.upright.png"), at(0, 0)))).toBe(
      "INVALID_SCHEMA",
    );
    expect(codeOf(await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), at(0, 2_500_000)))).toBe(
      "INVALID_SCHEMA",
    );
  });

  it("rejects non-video bytes and over-long clips", async () => {
    const h = await captureHarness();
    expect(
      codeOf(await h.ingestor.registerVideo({ bytes: captureFixture("upright-64x48.png"), width: 64, height: 48, durationUs: 1e6 })),
    ).toBe("UNSUPPORTED_MEDIA");
    expect(codeOf(await h.ingestor.registerVideo({ bytes: mp4Header(), width: 64, height: 48, durationUs: 31_000_000 }))).toBe(
      "TOO_LARGE",
    );
  });

  it("rejects a frame labeled with the wrong type or size", async () => {
    const { h, source } = await videoSource();
    const mislabeled: EncodedFrame = { ...frameOf("upright-64x48.png"), mimeType: "image/jpeg" };
    expect(codeOf(await h.ingestor.ingestFrame(source, mislabeled, at(0, 0)))).toBe("UNSUPPORTED_MEDIA");
    expect(frameMimeType(captureFixture("upright-64x48.jpg"))).toBe("image/jpeg");
  });
});

describe("CaptureIngestor: phone camera live source", () => {
  it("accepts fresh preview frames and drops stale ones as STALE_FRAME", async () => {
    const h = await captureHarness();
    const { source } = expectOk(await h.ingestor.startCameraSource({ width: 64, height: 48 }));
    expect(source).toMatchObject({ adapter: "phone_camera", assetId: null, contentHash: null, media: { kind: "live_stream" } });

    const fresh = expectOk(
      await h.ingestor.ingestFrame(source, frameOf("upright-64x48.png"), {
        sequence: 0,
        sourceTimeUs: 0,
        capturedAt: "2026-11-14T19:59:59.500Z", // 500 ms before the backend clock
        mode: "preview",
      }),
    );
    expect(fresh.result.status).toBe("accepted");

    const stale = await h.ingestor.ingestFrame(source, frameOf("upright-64x48.jpg"), {
      sequence: 1,
      sourceTimeUs: 33_333,
      capturedAt: "2026-11-14T19:59:55.000Z", // 5 s old on arrival
      mode: "preview",
    });
    expect(codeOf(stale)).toBe("STALE_FRAME");

    // An evidence frame (user tapped Capture) is never dropped for lag.
    const evidence = expectOk(
      await h.ingestor.ingestFrame(source, frameOf("upright-64x48.jpg"), {
        sequence: 2,
        sourceTimeUs: 66_666,
        capturedAt: "2026-11-14T19:59:55.000Z",
        mode: "evidence",
      }),
    );
    expect(evidence.result).toMatchObject({ status: "accepted", latestSequence: 2 });
  });

  it("accepts a phone camera still as an image source with the phone_camera adapter", async () => {
    const h = await captureHarness();
    const out = expectOk(
      await h.ingestor.ingestImage({ bytes: captureFixture("upright-64x48.jpg"), adapter: "phone_camera", capturedAt: "2026-11-14T19:59:00Z" }),
    );
    expect(out.envelope).toMatchObject({ adapter: "phone_camera", sequence: 0, capturedAt: "2026-11-14T19:59:00Z" });
  });
});

describe("CaptureIngestor: access", () => {
  it("surfaces gateway authorization errors unchanged", async () => {
    const h = await captureHarness();
    const { CaptureIngestor } = await import("@/lib/capture");
    const stranger = new CaptureIngestor({
      assets: h.backend.assets,
      ingestion: h.backend.ingestion,
      blobs: h.blobs,
      actor: { userId: "someone_else" },
      projectId: h.projectId,
    });
    expect(codeOf(await stranger.ingestImage({ bytes: captureFixture("upright-64x48.png"), adapter: "upload" }))).toBe("NOT_FOUND");
    const anon = new CaptureIngestor({ assets: h.backend.assets, ingestion: h.backend.ingestion, blobs: h.blobs, actor: null, projectId: h.projectId });
    expect(codeOf(await anon.ingestImage({ bytes: captureFixture("upright-64x48.png"), adapter: "upload" }))).toBe("UNAUTHORIZED");
  });
});
