/**
 * Create an empty project to capture into (tests, the dev harness and the
 * live-run CLI). Revision 1 holds an asset-free scene with one user camera,
 * per HK-001 D3: assets need a project to exist before they can be uploaded.
 */
import {
  newId,
  type Actor,
  type CreateProjectResponse,
  type ProjectRepository,
  type Result,
  type TakeManifest,
} from "@/lib/contracts";

export function emptyCaptureManifest(projectId: string, takeId = newId("take"), cameraId = newId("camera")): TakeManifest {
  return {
    schemaVersion: 1,
    projectId,
    take: {
      schemaVersion: 1,
      id: takeId,
      projectId,
      name: "Original",
      parent: null,
      frameRate: { num: 30, den: 1 },
      durationFrames: 0,
      activeCameraId: cameraId,
      sourceMappings: [],
      tracks: [],
    },
    scene: {
      schemaVersion: 1,
      coordinateSystem: { handedness: "right", up: "+Y", lengthUnit: "m", rotation: "quaternion_xyzw" },
      scale: { status: "estimated", reference: null },
      objects: [],
      cameras: [
        {
          id: cameraId,
          name: "Main camera",
          verticalFovDeg: 50,
          near: 0.05,
          far: 100,
          transform: { position: [0, 1.2, 2.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          origin: "user",
          observationId: null,
        },
      ],
      background: { mode: "solid", color: "#20232a" },
    },
  };
}

export function createCaptureProject(
  projects: ProjectRepository,
  actor: Actor,
  title: string,
  projectId = newId("project"),
): Promise<Result<CreateProjectResponse>> {
  return projects.createProject(actor, {
    projectId,
    title,
    initialManifest: emptyCaptureManifest(projectId),
    idempotencyKey: newId("revision").replace("rev_", "create-"),
  });
}
