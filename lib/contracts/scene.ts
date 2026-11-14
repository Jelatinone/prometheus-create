/**
 * CT-001 — Scene baseline and take documents.
 *
 * Three independent clocks (PLAN §4): source time (µs, immutable evidence),
 * take time (integer frames at a rational rate), simulation time (solver
 * ticks). Revision history is separate and never derived from a timestamp.
 */
import { z } from "zod";
import {
  AssetId,
  CameraId,
  Confirmation,
  ObjectId,
  ObservationId,
  ProjectId,
  Provenance,
  Rational,
  RevisionId,
  SchemaVersion,
  SourceId,
  TakeId,
  Timestamp,
  TrackId,
  Transform,
  UserId,
  Vec3,
} from "./common";

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const Project = z.strictObject({
  schemaVersion: SchemaVersion,
  id: ProjectId,
  ownerId: UserId,
  title: z.string().min(1).max(120),
  activeTakeId: TakeId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Scene objects: meshes are the editable geometry (D-003).
// ---------------------------------------------------------------------------

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

export const Material = z.discriminatedUnion("mode", [
  /** Use the materials embedded in the geometry GLB. */
  z.strictObject({ mode: z.literal("embedded") }),
  z.strictObject({
    mode: z.literal("solid"),
    color: HexColor,
    roughness: z.number().min(0).max(1),
    metalness: z.number().min(0).max(1),
  }),
]);
export type Material = z.infer<typeof Material>;

export const Bounds = z
  .strictObject({ min: Vec3, max: Vec3 })
  .refine((b) => b.min.every((v, i) => v <= b.max[i]), {
    message: "bounds.min must be <= bounds.max on every axis",
  });
export type Bounds = z.infer<typeof Bounds>;

/**
 * Geometry is an immutable canonical-space GLB. Each accepted change (new
 * reconstruction, mesh replacement) increments geometryRevision; jobs carry
 * the revision they started from so stale results never overwrite newer work.
 */
export const Geometry = z.strictObject({
  assetId: AssetId,
  geometryRevision: z.int().min(1),
  /** Provider/user original retained before normalization, if different. */
  originalAssetId: AssetId.nullable(),
  normalization: z.strictObject({
    sourceUnits: z.enum(["m", "cm", "mm", "unknown"]),
    sourceUpAxis: z.enum(["+Y", "+Z", "unknown"]),
    /** Uniform factor applied to reach meters. 1 when already meters. */
    scaleApplied: z.number().positive(),
    /** True when node transforms were baked into vertices (never re-apply). */
    nodeTransformsBaked: z.boolean(),
  }),
  /** Local-space bounds in meters, after normalization. */
  localBounds: Bounds,
});
export type Geometry = z.infer<typeof Geometry>;

export const PhysicalProperties = z.strictObject({
  bodyType: z.enum(["fixed", "dynamic"]),
  /** Policy when the object is resized (PLAN §4 physics and scaling). */
  massMode: z.enum(["keep_mass", "keep_density"]),
  massKg: z.number().positive().nullable(),
  densityKgM3: z.number().positive().nullable(),
  friction: z.number().nonnegative(),
  restitution: z.number().min(0).max(1),
  /** Unmeasured unless the user supplied evidence. */
  status: z.enum(["assumed", "user_supplied"]),
  joint: z
    .strictObject({
      kind: z.literal("revolute"),
      connectedObjectId: ObjectId.nullable(),
      axis: Vec3,
      anchorLocal: Vec3,
      connectedAnchorLocal: Vec3,
    })
    .nullable(),
});
export type PhysicalProperties = z.infer<typeof PhysicalProperties>;

export const SceneObject = z.strictObject({
  id: ObjectId,
  name: z.string().min(1).max(80),
  geometry: Geometry,
  material: Material,
  /** Baseline pose. Animated drivers supply absolute poses per interval. */
  transform: Transform,
  visible: z.boolean(),
  dimensionsStatus: Confirmation,
  provenance: Provenance,
  splat: z
    .strictObject({
      assetId: AssetId,
      enabled: z.boolean(),
      /** Splat is disabled once geometry changes past this revision. */
      validForGeometryRevision: z.int().min(1),
    })
    .nullable(),
  collider: z
    .strictObject({
      shape: z.enum(["box", "convex_hull", "compound", "trimesh"]),
      assetId: AssetId.nullable(),
    })
    .nullable(),
  physics: PhysicalProperties.nullable(),
});
export type SceneObject = z.infer<typeof SceneObject>;

/** Camera looks down its local -Z with +Y up (glTF/three.js convention). */
export const Camera = z
  .strictObject({
    id: CameraId,
    name: z.string().min(1).max(80),
    verticalFovDeg: z.number().gt(0).lt(180),
    near: z.number().positive(),
    far: z.number().positive(),
    transform: Transform,
    origin: z.enum(["source_estimate", "user"]),
    /** Observation whose estimated camera this came from, if any. */
    observationId: ObservationId.nullable(),
  })
  .refine((c) => c.far > c.near, { message: "far must be greater than near" });
export type Camera = z.infer<typeof Camera>;

export const Background = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("transparent") }),
  z.strictObject({ mode: z.literal("solid"), color: HexColor }),
  /** User-supplied clean plate or other valid observation. */
  z.strictObject({ mode: z.literal("source_plate"), observationId: ObservationId }),
]);

export const SceneDocument = z
  .strictObject({
    schemaVersion: SchemaVersion,
    coordinateSystem: z.strictObject({
      handedness: z.literal("right"),
      up: z.literal("+Y"),
      lengthUnit: z.literal("m"),
      rotation: z.literal("quaternion_xyzw"),
    }),
    /** Room scale is estimated until the user confirms one real length. */
    scale: z.strictObject({
      status: Confirmation,
      reference: z
        .strictObject({
          objectId: ObjectId,
          axis: z.enum(["x", "y", "z"]),
          lengthM: z.number().positive(),
        })
        .nullable(),
    }),
    objects: z.array(SceneObject),
    cameras: z.array(Camera),
    background: Background,
  })
  .superRefine((scene, ctx) => {
    const objectIds = new Set<string>();
    scene.objects.forEach((o, i) => {
      if (objectIds.has(o.id))
        ctx.addIssue({
          code: "custom",
          path: ["objects", i, "id"],
          message: `duplicate object id ${o.id}`,
        });
      objectIds.add(o.id);
    });
    const cameraIds = new Set<string>();
    scene.cameras.forEach((c, i) => {
      if (cameraIds.has(c.id))
        ctx.addIssue({
          code: "custom",
          path: ["cameras", i, "id"],
          message: `duplicate camera id ${c.id}`,
        });
      cameraIds.add(c.id);
    });
    if (scene.scale.status === "user_confirmed") {
      if (!scene.scale.reference)
        ctx.addIssue({
          code: "custom",
          path: ["scale", "reference"],
          message: "user_confirmed scale requires a reference length",
        });
      else if (!objectIds.has(scene.scale.reference.objectId))
        ctx.addIssue({
          code: "custom",
          path: ["scale", "reference", "objectId"],
          message: `unknown object ${scene.scale.reference.objectId}`,
        });
    }
    scene.objects.forEach((o, i) => {
      const joint = o.physics?.joint;
      if (joint?.connectedObjectId && !objectIds.has(joint.connectedObjectId))
        ctx.addIssue({
          code: "custom",
          path: ["objects", i, "physics", "joint", "connectedObjectId"],
          message: `unknown object ${joint.connectedObjectId}`,
        });
    });
  });
export type SceneDocument = z.infer<typeof SceneDocument>;

// ---------------------------------------------------------------------------
// Take: output sequence. Import is evidence, not animation.
// ---------------------------------------------------------------------------

/**
 * Maps take frames [takeInFrame, takeOutFrame) to source time:
 * t_source = sourceInUs + rate * (t_take - takeIn). rate 0 holds a frame.
 */
export const SourceMapping = z
  .strictObject({
    sourceId: SourceId,
    takeInFrame: z.int().nonnegative(),
    takeOutFrame: z.int().positive(),
    sourceInUs: z.int().nonnegative(),
    rate: z.number().nonnegative(),
  })
  .refine((m) => m.takeOutFrame > m.takeInFrame, {
    message: "takeOutFrame must be greater than takeInFrame",
  });
export type SourceMapping = z.infer<typeof SourceMapping>;

export const Keyframe = z.strictObject({
  frame: z.int().nonnegative(),
  transform: Transform,
  interpolation: z.enum(["linear", "step"]),
});
export type Keyframe = z.infer<typeof Keyframe>;

export const TrackTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("object"), objectId: ObjectId }),
  z.strictObject({ kind: z.literal("camera"), cameraId: CameraId }),
]);
export type TrackTarget = z.infer<typeof TrackTarget>;

const trackBase = {
  id: TrackId,
  target: TrackTarget,
  /** Inclusive start, exclusive end, in take frames. */
  startFrame: z.int().nonnegative(),
  endFrame: z.int().positive(),
};

/**
 * Exactly one driver supplies an absolute pose per target and interval;
 * there is no hidden stack of competing transforms.
 */
export const Track = z.discriminatedUnion("driver", [
  z.strictObject({
    ...trackBase,
    driver: z.literal("keyframes"),
    keyframes: z.array(Keyframe).min(1),
  }),
  z.strictObject({
    ...trackBase,
    driver: z.literal("observed"),
    sourceId: SourceId,
    /** Baked pose cache asset (kind "motion"). */
    motionAssetId: AssetId,
  }),
  z.strictObject({
    ...trackBase,
    driver: z.literal("simulation"),
    simulationRunId: z.string().min(1).max(128),
  }),
]);
export type Track = z.infer<typeof Track>;

function targetKey(t: TrackTarget): string {
  return t.kind === "object" ? `object:${t.objectId}` : `camera:${t.cameraId}`;
}

export const TakeDocument = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: TakeId,
    projectId: ProjectId,
    name: z.string().min(1).max(80),
    /** Set when forked: the take and exact revision it was copied from. */
    parent: z.strictObject({ takeId: TakeId, revisionId: RevisionId }).nullable(),
    frameRate: Rational,
    /** 0 means still-only; playback/video takes default to 5 s. */
    durationFrames: z.int().nonnegative(),
    activeCameraId: CameraId.nullable(),
    sourceMappings: z.array(SourceMapping),
    tracks: z.array(Track),
  })
  .superRefine((take, ctx) => {
    const trackIds = new Set<string>();
    const byTarget = new Map<string, { start: number; end: number; index: number }[]>();
    take.tracks.forEach((track, i) => {
      if (trackIds.has(track.id))
        ctx.addIssue({
          code: "custom",
          path: ["tracks", i, "id"],
          message: `duplicate track id ${track.id}`,
        });
      trackIds.add(track.id);
      if (track.endFrame <= track.startFrame)
        ctx.addIssue({
          code: "custom",
          path: ["tracks", i, "endFrame"],
          message: "endFrame must be greater than startFrame",
        });
      if (track.endFrame > take.durationFrames)
        ctx.addIssue({
          code: "custom",
          path: ["tracks", i, "endFrame"],
          message: `track ends after take duration (${take.durationFrames})`,
        });
      if (track.driver === "keyframes") {
        let prev = -1;
        track.keyframes.forEach((k, j) => {
          if (k.frame <= prev)
            ctx.addIssue({
              code: "custom",
              path: ["tracks", i, "keyframes", j, "frame"],
              message: "keyframes must be strictly increasing",
            });
          if (k.frame < track.startFrame || k.frame >= track.endFrame)
            ctx.addIssue({
              code: "custom",
              path: ["tracks", i, "keyframes", j, "frame"],
              message: "keyframe outside track interval",
            });
          prev = k.frame;
        });
      }
      const key = targetKey(track.target);
      const intervals = byTarget.get(key) ?? [];
      for (const other of intervals) {
        if (track.startFrame < other.end && other.start < track.endFrame)
          ctx.addIssue({
            code: "custom",
            path: ["tracks", i],
            message: `UNSUPPORTED_DRIVER: overlaps track ${other.index} for ${key}; one driver per target and interval`,
          });
      }
      intervals.push({ start: track.startFrame, end: track.endFrame, index: i });
      byTarget.set(key, intervals);
    });
    take.sourceMappings.forEach((m, i) => {
      if (take.durationFrames > 0 && m.takeOutFrame > take.durationFrames)
        ctx.addIssue({
          code: "custom",
          path: ["sourceMappings", i, "takeOutFrame"],
          message: `mapping ends after take duration (${take.durationFrames})`,
        });
    });
  });
export type TakeDocument = z.infer<typeof TakeDocument>;

/** Dimensions (m) of an object's local bounds after its scale is applied. */
export function objectDimensions(object: SceneObject): [number, number, number] {
  const { min, max } = object.geometry.localBounds;
  const s = object.transform.scale;
  return [
    (max[0] - min[0]) * s[0],
    (max[1] - min[1]) * s[1],
    (max[2] - min[2]) * s[2],
  ];
}
