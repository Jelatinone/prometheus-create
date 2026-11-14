/**
 * Named registry of every contract schema. Used by the CLI validator
 * (`npm run validate`) and JSON Schema export for
 * non-TypeScript consumers (e.g. the Python capture agent).
 */
import type { z } from "zod";
import { Asset } from "./asset";
import { ContractError } from "./common";
import { ExportManifest, ExportSpec } from "./export";
import { IngestEnvelope, IngestResult, ReconstructionJob } from "./ingestion";
import { Proposal } from "./proposal";
import {
  CreateProjectRequest,
  CreateProjectResponse,
  ForkTakeRequest,
  ForkTakeResponse,
  Revision,
  SaveRevisionRequest,
  SaveRevisionResponse,
  TakeManifest,
  TakeSummary,
} from "./revision";
import { Project, SceneDocument, TakeDocument } from "./scene";
import { CaptureSession, Observation, Source, SourceRegistration } from "./source";

export interface ContractEntry {
  schema: z.ZodType;
  contract: "CT-001" | "CT-002" | "CT-003" | "CT-004" | "CT-005" | "shared";
  description: string;
}

export const CONTRACTS = {
  project: { schema: Project, contract: "CT-001", description: "Project record" },
  "scene-document": { schema: SceneDocument, contract: "CT-001", description: "Scene baseline: objects, cameras, scale, background" },
  "take-document": { schema: TakeDocument, contract: "CT-001", description: "Take: frame rate, duration, source mappings, tracks" },
  proposal: { schema: Proposal, contract: "CT-001", description: "AI-suggested change awaiting user decision" },
  asset: { schema: Asset, contract: "shared", description: "Immutable stored binary" },
  source: { schema: Source, contract: "CT-002", description: "Registered photo, clip, or live stream" },
  "source-registration": { schema: SourceRegistration, contract: "CT-002", description: "Request to register a source" },
  observation: { schema: Observation, contract: "CT-002", description: "One frame of a source at a presentation time" },
  "ingest-envelope": { schema: IngestEnvelope, contract: "CT-002", description: "Per-frame ingestion message from any adapter" },
  "ingest-result": { schema: IngestResult, contract: "CT-002", description: "Ingestion outcome" },
  "reconstruction-job": { schema: ReconstructionJob, contract: "CT-002", description: "Provider job with state log" },
  "take-manifest": { schema: TakeManifest, contract: "CT-003", description: "Saved snapshot: take + its scene baseline" },
  revision: { schema: Revision, contract: "CT-003", description: "Immutable saved revision" },
  "save-revision-request": { schema: SaveRevisionRequest, contract: "CT-003", description: "Compare-and-swap save" },
  "save-revision-response": { schema: SaveRevisionResponse, contract: "CT-003", description: "Save result" },
  "create-project-request": { schema: CreateProjectRequest, contract: "CT-003", description: "Create project + original take" },
  "create-project-response": { schema: CreateProjectResponse, contract: "CT-003", description: "Created project" },
  "fork-take-request": { schema: ForkTakeRequest, contract: "CT-003", description: "Fork a take at an exact revision" },
  "fork-take-response": { schema: ForkTakeResponse, contract: "CT-003", description: "Fork result" },
  "take-summary": { schema: TakeSummary, contract: "CT-003", description: "Take list entry" },
  "export-spec": { schema: ExportSpec, contract: "CT-004", description: "What to export" },
  "export-manifest": { schema: ExportManifest, contract: "CT-004", description: "What was exported, with omissions" },
  "capture-session": { schema: CaptureSession, contract: "CT-005", description: "Capture call lifecycle" },
  "contract-error": { schema: ContractError, contract: "shared", description: "Error value returned by every port" },
} as const satisfies Record<string, ContractEntry>;

export type ContractName = keyof typeof CONTRACTS;

export const CONTRACT_NAMES = Object.keys(CONTRACTS) as ContractName[];

export function isContractName(name: string): name is ContractName {
  return Object.hasOwn(CONTRACTS, name);
}
