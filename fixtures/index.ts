/**
 * Golden contract fixtures as importable modules (for /lab and lane code).
 * tests/contracts/fixtures-index.test.ts fails if a JSON file is missing here.
 * Only axis-box.glb's hash refers to a committed file; other content hashes
 * are labeled placeholders for media that is not checked in.
 */
import type { ContractName } from "@/lib/contracts/registry";
import assetAxisBox from "./contracts/asset.axis-box.json";
import captureSessionActive from "./contracts/capture-session.active.json";
import exportSpecPngStill from "./contracts/export-spec.png-still.json";
import ingestEnvelopeChertFrame from "./contracts/ingest-envelope.chert-frame.json";
import ingestEnvelopeImageUpload from "./contracts/ingest-envelope.image-upload.json";
import proposalPending from "./contracts/proposal.pending.json";
import reconstructionJobSucceeded from "./contracts/reconstruction-job.succeeded.json";
import saveRevisionRequestAlternate from "./contracts/save-revision-request.alternate.json";
import sourceChertLive from "./contracts/source.chert-live.json";
import sourceImageUpload from "./contracts/source.image-upload.json";
import takeManifestAlternate from "./contracts/take-manifest.alternate.json";
import takeManifestOriginal from "./contracts/take-manifest.original.json";
import invIngestBareHex from "./contracts/invalid/ingest-envelope.bare-hex-hash.json";
import invIngestMs from "./contracts/invalid/ingest-envelope.milliseconds-field.json";
import invJobNoMesh from "./contracts/invalid/reconstruction-job.succeeded-without-mesh.json";
import invSaveWrongTake from "./contracts/invalid/save-revision-request.wrong-take.json";
import invSourceLiveAsset from "./contracts/invalid/source.live-stream-with-asset.json";
import invQuat from "./contracts/invalid/take-manifest.non-unit-quaternion.json";
import invOverlap from "./contracts/invalid/take-manifest.overlapping-drivers.json";

export interface FixtureEntry {
  file: string;
  contract: ContractName;
  document: unknown;
  /** Present for invalid cases: where validation must fail. */
  expect?: { path: string; messageIncludes: string };
}

export const GOLDEN_FIXTURES: FixtureEntry[] = [
  { file: "asset.axis-box.json", contract: "asset", document: assetAxisBox },
  { file: "capture-session.active.json", contract: "capture-session", document: captureSessionActive },
  { file: "export-spec.png-still.json", contract: "export-spec", document: exportSpecPngStill },
  { file: "ingest-envelope.chert-frame.json", contract: "ingest-envelope", document: ingestEnvelopeChertFrame },
  { file: "ingest-envelope.image-upload.json", contract: "ingest-envelope", document: ingestEnvelopeImageUpload },
  { file: "proposal.pending.json", contract: "proposal", document: proposalPending },
  { file: "reconstruction-job.succeeded.json", contract: "reconstruction-job", document: reconstructionJobSucceeded },
  { file: "save-revision-request.alternate.json", contract: "save-revision-request", document: saveRevisionRequestAlternate },
  { file: "source.chert-live.json", contract: "source", document: sourceChertLive },
  { file: "source.image-upload.json", contract: "source", document: sourceImageUpload },
  { file: "take-manifest.alternate.json", contract: "take-manifest", document: takeManifestAlternate },
  { file: "take-manifest.original.json", contract: "take-manifest", document: takeManifestOriginal },
];

const invalid = (file: string, contract: ContractName, raw: { expect: FixtureEntry["expect"]; document: unknown }) => ({
  file: `invalid/${file}`,
  contract,
  document: raw.document,
  expect: raw.expect,
});

export const INVALID_FIXTURES: FixtureEntry[] = [
  invalid("ingest-envelope.bare-hex-hash.json", "ingest-envelope", invIngestBareHex),
  invalid("ingest-envelope.milliseconds-field.json", "ingest-envelope", invIngestMs),
  invalid("reconstruction-job.succeeded-without-mesh.json", "reconstruction-job", invJobNoMesh),
  invalid("save-revision-request.wrong-take.json", "save-revision-request", invSaveWrongTake),
  invalid("source.live-stream-with-asset.json", "source", invSourceLiveAsset),
  invalid("take-manifest.non-unit-quaternion.json", "take-manifest", invQuat),
  invalid("take-manifest.overlapping-drivers.json", "take-manifest", invOverlap),
];

export const AXIS_BOX_GLB_URL = "/fixtures/axis-box.glb";
