/**
 * AI proposals (CT-001 Proposal, F-008). A model suggests; the user accepts
 * or rejects. Schema-valid output is not proof a measurement is correct, and
 * proposals are never auto-applied.
 */
import { z } from "zod";
import {
  AssetId,
  ObjectId,
  ObservationId,
  PositiveVec3,
  ProjectId,
  ProposalId,
  SchemaVersion,
  Timestamp,
  Transform,
} from "./common";

export const ProposalChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rename"), name: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal("set_transform"), transform: Transform }),
  z.strictObject({ kind: z.literal("set_dimensions"), dimensionsM: PositiveVec3 }),
  /** Suggested segmentation target in source pixel coordinates. */
  z.strictObject({
    kind: z.literal("segment_target"),
    label: z.string().min(1).max(80),
    maskAssetId: AssetId.nullable(),
    boxPx: z.tuple([z.int(), z.int(), z.int(), z.int()]).nullable(),
  }),
]);
export type ProposalChange = z.infer<typeof ProposalChange>;

export const Proposal = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: ProposalId,
    projectId: ProjectId,
    /** The fresh frames the proposal is grounded in. */
    observationIds: z.array(ObservationId).min(1),
    targetObjectId: ObjectId.nullable(),
    change: ProposalChange,
    rationale: z.string().max(2000),
    /** Explicit assumptions, e.g. "chair seat height assumed 0.45 m". */
    assumptions: z.array(z.string().max(300)),
    status: z.enum(["pending", "accepted", "rejected"]),
    provider: z.strictObject({ name: z.string().min(1), model: z.string().min(1) }),
    createdAt: Timestamp,
    decidedAt: Timestamp.nullable(),
  })
  .refine((p) => (p.status === "pending") === (p.decidedAt === null), {
    message: "decidedAt is set exactly when the proposal is accepted or rejected",
    path: ["decidedAt"],
  });
export type Proposal = z.infer<typeof Proposal>;
