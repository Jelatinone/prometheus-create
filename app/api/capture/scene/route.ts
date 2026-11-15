import { z } from "zod";
import { ProjectId, SourceId, err } from "@/lib/contracts";
import { getActor } from "@/lib/server/auth";
import { getBackend } from "@/lib/server/backend";
import { readBody, respond } from "@/lib/server/http";
import { startSceneBuild } from "@/lib/server/facetime-call";

const StartScene = z.strictObject({
  projectId: ProjectId,
  sourceId: SourceId,
  detail: z.enum(["light", "standard", "dense"]).default("standard"),
});

/** Build a scene splat from one capture's frames in the background; progress is GET /api/capture/call. */
export async function POST(request: Request) {
  try {
    const actor = await getActor(request);
    if (!actor) return respond(err("UNAUTHORIZED", "sign in required"));
    const body = await readBody(request, StartScene);
    if (!body.ok) return respond(body);
    const backend = getBackend();
    const project = await backend.projects.getProject(actor, body.value.projectId);
    if (!project.ok) return respond(project);
    const started = startSceneBuild({ backend, actor, ...body.value });
    return respond(started, started.ok ? 202 : undefined);
  } catch (error) {
    console.error("[api] POST /api/capture/scene failed:", error);
    return respond(err("PROVIDER_UNAVAILABLE", "the scene build could not be started"));
  }
}
