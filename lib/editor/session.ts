/**
 * Take session orchestration over the ProjectRepository port (HK-004/HK-005).
 * Works with MemoryBackend in tests and HttpBackend in the browser.
 *
 * Saves always send the revision the editor loaded (`expectedRevision`), so a
 * stale save comes back as REVISION_CONFLICT and is never silently overwritten.
 */
import { err, newId, ok, type Result } from "@/lib/contracts/common";
import type { Actor, ProjectRepository } from "@/lib/contracts/ports";
import type { Revision, TakeManifest, TakeSummary } from "@/lib/contracts/revision";
import type { Project } from "@/lib/contracts/scene";

export interface LoadedTake {
  project: Project;
  takes: TakeSummary[];
  revision: Revision;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** The given take (or the project's active take) at its head revision. */
export async function loadTake(
  repo: ProjectRepository,
  actor: Actor,
  projectId: string,
  takeId?: string,
): Promise<Result<LoadedTake>> {
  const project = await repo.getProject(actor, projectId);
  if (!project.ok) return project;
  const takes = await repo.listTakes(actor, projectId);
  if (!takes.ok) return takes;
  const wanted = takeId ?? project.value.activeTakeId;
  if (!takes.value.some((t) => t.takeId === wanted)) return err("NOT_FOUND", `take ${wanted} is not in this project`);
  const revision = await repo.getRevision(actor, projectId, wanted);
  if (!revision.ok) return revision;
  return ok({ project: project.value, takes: takes.value, revision: revision.value });
}

export async function saveTake(
  repo: ProjectRepository,
  actor: Actor,
  manifest: TakeManifest,
  expectedRevision: number,
  message: string | null = null,
) {
  return repo.saveRevision(actor, {
    projectId: manifest.projectId,
    takeId: manifest.take.id,
    expectedRevision,
    manifest,
    idempotencyKey: idempotencyKey("save"),
    message,
  });
}

/** Forks the saved revision `fromRevision` (not unsaved edits) into a new take. */
export async function forkTake(
  repo: ProjectRepository,
  actor: Actor,
  from: { projectId: string; takeId: string; revision: number },
  name: string,
) {
  return repo.forkTake(actor, {
    projectId: from.projectId,
    fromTakeId: from.takeId,
    fromRevision: from.revision,
    newTakeId: newId("take"),
    name: name.trim().slice(0, 80) || "Alternate",
    idempotencyKey: idempotencyKey("fork"),
  });
}

/** A default name that does not collide with existing takes: "Alternate", "Alternate 2", … */
export function nextTakeName(takes: TakeSummary[], base = "Alternate"): string {
  const names = new Set(takes.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
