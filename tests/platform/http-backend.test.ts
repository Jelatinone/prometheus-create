/**
 * HttpBackend / PlatformBlobStore behavior that needs no credentials:
 * Result reconstruction, failure mapping, credentials per actor, URL
 * building, storage-key parsing, and the in-process route table.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/contracts/common";
import { parseAssetKey } from "@/lib/platform/blob-store";
import { HttpBackend } from "@/lib/platform/http-backend";
import { REPO_ROOT } from "../helpers/fixtures";
import { ROUTE_FILES } from "./route-fetch";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const actor = { userId: "user_a" };

describe("HttpBackend", () => {
  it("returns success bodies as ok values", async () => {
    const project = { id: "prj_abc" };
    const { calls, fetchImpl } = fakeFetch(() => Response.json(project, { status: 200 }));
    const api = new HttpBackend({ baseUrl: "https://app.example/", fetch: fetchImpl });
    expect(await api.projects.getProject(actor, "prj_abc")).toEqual({ ok: true, value: project });
    expect(calls[0].url).toBe("https://app.example/api/projects/prj_abc");
    expect(calls[0].init.method).toBe("GET");
  });

  it("passes contract errors through with code and details", async () => {
    const error = { code: "REVISION_CONFLICT", message: "take is at revision 3, not 2", details: { currentRevision: 3 } };
    const { fetchImpl } = fakeFetch(() => Response.json({ error }, { status: 409 }));
    const r = await new HttpBackend({ fetch: fetchImpl }).projects.getRevision(actor, "prj_abc", "tk_abc");
    expect(r).toEqual({ ok: false, error });
  });

  it("maps network failures and non-contract responses to PROVIDER_UNAVAILABLE", async () => {
    const down = new HttpBackend({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const offline = await down.listProjects(actor);
    expect(offline.ok ? null : offline.error.code).toBe("PROVIDER_UNAVAILABLE");

    const { fetchImpl } = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const html = await new HttpBackend({ fetch: fetchImpl }).listProjects(actor);
    expect(html.ok ? null : html.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { status: 502 } });
  });

  it("reports UNAUTHORIZED to the onUnauthorized hook", async () => {
    const onUnauthorized = vi.fn();
    const { fetchImpl } = fakeFetch(() =>
      Response.json({ error: { code: "UNAUTHORIZED", message: "sign in required" } }, { status: 401 }),
    );
    const r = await new HttpBackend({ fetch: fetchImpl, onUnauthorized }).listProjects(actor);
    expect(r.ok ? null : r.error.code).toBe("UNAUTHORIZED");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("sends the session cookie for a signed-in actor and nothing for null (default)", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json([]));
    const api = new HttpBackend({ fetch: fetchImpl });
    await api.listProjects(actor);
    await api.listProjects(null);
    expect(calls.map((c) => c.init.credentials)).toEqual(["same-origin", "omit"]);
  });

  it("uses bearer headers from authorize and JSON bodies for commands", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}, { status: 201 }));
    const api = new HttpBackend({
      fetch: fetchImpl,
      authorize: (a) => (a ? { headers: { authorization: `Bearer token-for-${a.userId}` } } : {}),
    });
    const job = { id: "job_abc", projectId: "prj_abc" } as never;
    await api.jobs.createJob(actor, job);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-for-user_a");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(job);
  });

  it("answers impossible revision numbers NOT_FOUND without a request (port semantics)", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    const api = new HttpBackend({ fetch: fetchImpl });
    for (const bad of [0, -1, 1.5, 2 ** 40]) {
      const r = await api.projects.getRevision(actor, "prj_abc", "tk_abc", bad);
      expect(r.ok ? null : r.error.code).toBe("NOT_FOUND");
    }
    expect(calls).toHaveLength(0);
    await api.projects.getRevision(actor, "prj_abc", "tk_abc", 3);
    expect(calls[0].url).toBe("/api/projects/prj_abc/takes/tk_abc/revisions?revision=3");
  });

  it("encodes path and query values", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({}));
    await new HttpBackend({ fetch: fetchImpl }).ingestion.getSource(actor, "prj_a&b", "src_x/y");
    expect(calls[0].url).toBe("/api/ingest/sources/src_x%2Fy?projectId=prj_a%26b");
  });
});

describe("parseAssetKey", () => {
  it("accepts capture, platform and bucket-qualified keys", () => {
    const p = newId("project");
    const a = newId("asset");
    for (const key of [`projects/${p}/assets/${a}`, `projects/${p}/${a}`, `project-assets/projects/${p}/${a}`])
      expect(parseAssetKey(key)).toEqual({ projectId: p, assetId: a });
    for (const key of ["fixtures/axis-box.glb", `projects/${p}`, `projects/${p}/${a}/extra`, `projects/x/${a}`])
      expect(parseAssetKey(key)).toBeNull();
  });
});

describe("in-process route table", () => {
  it("covers every app/api route file", () => {
    const apiDir = join(REPO_ROOT, "app/api");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === "route.ts") found.push("/" + relative(join(REPO_ROOT, "app"), dir).replaceAll("\\", "/"));
      }
    };
    walk(apiDir);
    expect(Object.keys(ROUTE_FILES).sort()).toEqual(found.sort());
  });
});
