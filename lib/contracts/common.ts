/**
 * Shared primitives for every contract (CT-001 … CT-005).
 *
 * Canonical 3D convention (PLAN §4): right-handed, meters, +Y up,
 * quaternions stored as [x, y, z, w]. Local mesh vertices plus one object
 * transform; adapters normalize third-party output before it reaches here.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// Identifiers: `<prefix>_<suffix>` so a pasted ID is self-describing.
// ---------------------------------------------------------------------------

export const ID_PREFIXES = {
  project: "prj",
  take: "tk",
  revision: "rev",
  object: "obj",
  camera: "cam",
  track: "trk",
  source: "src",
  observation: "obs",
  asset: "ast",
  job: "job",
  captureSession: "cap",
  proposal: "prp",
  export: "exp",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ID_SUFFIX = "[a-z0-9][a-z0-9_-]{2,63}";

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ID_SUFFIX}$`);
}

function idSchema(kind: IdKind) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(idPattern(kind), `expected a ${kind} id like "${prefix}_abc123"`);
}

/** Generate a fresh random ID. Works in browsers and Node 22+. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

export const ProjectId = idSchema("project");
export const TakeId = idSchema("take");
export const RevisionId = idSchema("revision");
export const ObjectId = idSchema("object");
export const CameraId = idSchema("camera");
export const TrackId = idSchema("track");
export const SourceId = idSchema("source");
export const ObservationId = idSchema("observation");
export const AssetId = idSchema("asset");
export const JobId = idSchema("job");
export const CaptureSessionId = idSchema("captureSession");
export const ProposalId = idSchema("proposal");
export const ExportId = idSchema("export");

/** Identity-provider user ID (e.g. Supabase auth UUID). Opaque to contracts. */
export const UserId = z.string().min(1).max(128);

/** Client-generated retry key. Same key + same payload => same result. */
export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, "expected 8-128 chars of [A-Za-z0-9_-]");

// ---------------------------------------------------------------------------
// Time, hashes, numbers
// ---------------------------------------------------------------------------

/** Wall-clock instant, ISO 8601 with an explicit offset. Never a media time. */
export const Timestamp = z.iso.datetime({ offset: true });

/** Content hash of stored bytes: `sha256:<64 lowercase hex>`. */
export const ContentHash = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:<64 hex chars>"');

/** Rational rate such as 30000/1001 fps. */
export const Rational = z.strictObject({
  num: z.int().positive(),
  den: z.int().positive(),
});
export type Rational = z.infer<typeof Rational>;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

const QUAT_TOLERANCE = 1e-3;

/** Unit quaternion [x, y, z, w]. */
export const Quat = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) <= QUAT_TOLERANCE, {
    message: "rotation must be a unit quaternion [x, y, z, w]",
  });
export type Quat = z.infer<typeof Quat>;

export const PositiveVec3 = z.tuple([
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
]);

/**
 * Absolute pose in the canonical frame. Scale is positive per axis; the MVP
 * editor only produces uniform scale, but imported nodes may not be uniform.
 */
export const Transform = z.strictObject({
  position: Vec3,
  rotation: Quat,
  scale: PositiveVec3,
});
export type Transform = z.infer<typeof Transform>;

export const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** Whether a value was inferred or explicitly confirmed by the user. */
export const Confirmation = z.enum(["estimated", "user_confirmed"]);
export type Confirmation = z.infer<typeof Confirmation>;

// ---------------------------------------------------------------------------
// Provenance: AI proposes, the user corrects; keep the evidence trail.
// ---------------------------------------------------------------------------

export const ProvenanceKind = z.enum([
  "capture", // derived from a real capture of this project
  "import", // user-supplied file (e.g. GLB import)
  "generated", // provider output (e.g. image-to-mesh job)
  "user", // authored in the editor
  "fixture", // prepared demo/test asset — must stay visibly labeled
]);

export const Provenance = z.strictObject({
  kind: ProvenanceKind,
  sourceIds: z.array(SourceId),
  observationIds: z.array(ObservationId),
  jobId: JobId.nullable(),
  /** Provider/model identifier, e.g. "fal-ai/sam-3/3d-objects". */
  provider: z.string().nullable(),
  note: z.string().max(500).nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

// ---------------------------------------------------------------------------
// Errors as values. Every port returns Result<T>; HTTP maps codes to status.
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  // CT-001 scene
  "INVALID_SCHEMA",
  "MISSING_ASSET",
  "UNKNOWN_UNITS",
  "UNSUPPORTED_DRIVER",
  "STALE_CACHE",
  // CT-002 ingestion / reconstruction
  "UNAUTHORIZED",
  "NOT_FOUND",
  "UNSUPPORTED_MEDIA",
  "TOO_LARGE",
  "STALE_FRAME",
  "DUPLICATE",
  "PROVIDER_UNAVAILABLE",
  "INVALID_GEOMETRY",
  "INVALID_TRANSITION",
  // CT-003 persistence
  "REVISION_CONFLICT",
  "INVALID_ASSET_REFERENCE",
  "IDEMPOTENCY_KEY_REUSED",
  // CT-004 export
  "UNSUPPORTED_CODEC",
  "TAINTED_CANVAS",
  "STALE_REVISION",
  "RESOURCE_LIMIT",
  // CT-005 capture call
  "LINE_NOT_READY",
  "CALLER_CAPTURE_UNAVAILABLE",
  "NO_FRESH_FRAME",
  "CALL_ENDED",
  "PROVIDER_ERROR",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ContractError = z.strictObject({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ContractError = z.infer<typeof ContractError>;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Result<T> {
  return {
    ok: false,
    error: details ? { code, message, details } : { code, message },
  };
}

/**
 * HTTP status for each code. Authenticated access to another user's project
 * returns NOT_FOUND (404), never 403, so IDs cannot be probed.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_SCHEMA: 422,
  MISSING_ASSET: 422,
  UNKNOWN_UNITS: 422,
  UNSUPPORTED_DRIVER: 422,
  STALE_CACHE: 409,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  UNSUPPORTED_MEDIA: 415,
  TOO_LARGE: 413,
  STALE_FRAME: 409,
  DUPLICATE: 409,
  PROVIDER_UNAVAILABLE: 503,
  INVALID_GEOMETRY: 422,
  INVALID_TRANSITION: 409,
  REVISION_CONFLICT: 409,
  INVALID_ASSET_REFERENCE: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  UNSUPPORTED_CODEC: 415,
  TAINTED_CANVAS: 422,
  STALE_REVISION: 409,
  RESOURCE_LIMIT: 429,
  LINE_NOT_READY: 503,
  CALLER_CAPTURE_UNAVAILABLE: 503,
  NO_FRESH_FRAME: 504,
  CALL_ENDED: 410,
  PROVIDER_ERROR: 502,
};

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Format a zod path like `scene.objects[0].transform.rotation`. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || "(root)";
}

/**
 * Validate unknown input against a contract schema. Failures become an
 * INVALID_SCHEMA ContractError with `details.issues` = [{ path, message }].
 */
export function parseContract<S extends z.ZodType>(
  schema: S,
  input: unknown,
): Result<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const issues: ValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
  return err("INVALID_SCHEMA", `${issues.length} validation issue(s)`, {
    issues,
  });
}
