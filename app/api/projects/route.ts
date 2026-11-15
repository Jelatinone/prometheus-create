// GET: my projects. POST: create a project (CreateProjectRequest) -> revision 1.
import * as api from "@/lib/server/api";
import { route } from "@/lib/server/route";

export const GET = route((ctx) => api.listProjects(ctx));
export const POST = route((ctx, request) => api.createProject(ctx, request));
