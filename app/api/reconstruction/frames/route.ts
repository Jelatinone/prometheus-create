import { Observation, ProjectId, err, ok } from "@/lib/contracts";
import { getActor } from "@/lib/server/auth";
import { getBackend } from "@/lib/server/backend";
import { readQuery, respond } from "@/lib/server/http";

/** Project-scoped read model; existing ingestion ports still own frame writes. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    if (!actor) return respond(err("UNAUTHORIZED", "sign in required"));
    const projectId = readQuery(request, "projectId", ProjectId);
    if (!projectId.ok) return respond(projectId);
    const backend = getBackend();
    const owner = await backend.projects.getProject(actor, projectId.value);
    if (!owner.ok) return respond(owner);
    const { rows } = await backend.pool.query<{ doc: unknown }>(
      "select o.doc from observations o join projects p on p.id = o.project_id where p.id = $1 and p.owner_id = $2 order by o.received_at desc limit 100",
      [projectId.value, actor.userId],
    );
    return respond(ok(rows.map(r => Observation.parse(r.doc))));
  } catch {
    return respond(err("PROVIDER_UNAVAILABLE", "captured frames could not be loaded"));
  }
}
