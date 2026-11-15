import { z } from "zod";
import { ProjectId, err, ok } from "@/lib/contracts";
import { createSessionClient, getActor, requestCookieJar } from "@/lib/server/auth";
import { getBackend } from "@/lib/server/backend";
import { readBody, respond } from "@/lib/server/http";
import { callState, codeMatches, startCall } from "@/lib/server/facetime-call";

const StartCall = z.strictObject({
  projectId: ProjectId,
  code: z.string().min(1).max(200),
  sceneSplat: z.boolean().default(false),
});

/** Start a FaceTime capture into a project; gated by the server-side CALL_ACCESS_CODE. */
export async function POST(request: Request) {
  try {
    const actor = await getActor(request);
    if (!actor) return respond(err("UNAUTHORIZED", "sign in required"));
    if (!process.env.CALL_ACCESS_CODE) return respond(err("PROVIDER_UNAVAILABLE", "FaceTime capture is turned off on this server"));
    const body = await readBody(request, StartCall);
    if (!body.ok) return respond(body);
    if (!codeMatches(body.value.code)) return respond(err("UNAUTHORIZED", "that access code is not right"));
    const backend = getBackend();
    const project = await backend.projects.getProject(actor, body.value.projectId);
    if (!project.ok) return respond(project);
    const header = request.headers.get("authorization");
    const accessToken = header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? (await createSessionClient(requestCookieJar(request)).auth.getSession()).data.session?.access_token;
    if (!accessToken) return respond(err("UNAUTHORIZED", "sign in again to start a call"));
    const started = startCall({ backend, actor, accessToken, projectId: body.value.projectId, origin: new URL(request.url).origin, sceneSplat: body.value.sceneSplat });
    return respond(started, started.ok ? 202 : undefined);
  } catch (error) {
    console.error("[api] POST /api/capture/call failed:", error);
    return respond(err("PROVIDER_UNAVAILABLE", "the call could not be started"));
  }
}

/** Progress of the current or last call (one call at a time per server). */
export async function GET(request: Request) {
  const actor = await getActor(request);
  if (!actor) return respond(err("UNAUTHORIZED", "sign in required"));
  return respond(ok(callState()));
}
