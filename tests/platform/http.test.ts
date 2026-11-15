/**
 * HTTP edge behavior that needs no credentials: body parsing limits, error
 * mapping through HTTP_STATUS, auth-before-validation ordering, and
 * body/URL consistency. Handlers run over the in-memory reference backend.
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES, HTTP_STATUS, err, newId, ok } from "@/lib/contracts";
import { MemoryBackend } from "@/lib/reference/memory-backend";
import * as api from "@/lib/server/api";
import { requestCookieJar } from "@/lib/server/auth";
import { MAX_BODY_BYTES, readJson, readQuery, respond } from "@/lib/server/http";
import { RevisionNumberQuery } from "@/lib/server/http-schemas";
import { safeNext } from "@/lib/platform/redirect";
import { retargetedFixture } from "@/lib/platform/fixture-project";

const json = (body: unknown, init: RequestInit = {}) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

function memoryContext(userId: string | null): api.ApiContext {
  const backend = Object.assign(new MemoryBackend(), { listProjects: async () => ok([]) });
  return { backend, actor: userId ? { userId } : null };
}

describe("readJson", () => {
  it("accepts application/json (with charset)", async () => {
    const r = await readJson(json({ a: 1 }, { headers: { "content-type": "application/json; charset=utf-8" } }));
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects other content types as UNSUPPORTED_MEDIA (415)", async () => {
    const r = await readJson(json("a=1", { headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(r.ok ? null : r.error.code).toBe("UNSUPPORTED_MEDIA");
    expect(respond(r).status).toBe(415);
  });

  it("rejects malformed JSON as INVALID_SCHEMA (422)", async () => {
    const r = await readJson(json("{not json"));
    expect(r.ok ? null : r.error.code).toBe("INVALID_SCHEMA");
    expect(respond(r).status).toBe(422);
  });

  it("caps metadata bodies at 1 MiB, declared or streamed (413)", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    const streamed = await readJson(json(big));
    expect(streamed.ok ? null : streamed.error.code).toBe("TOO_LARGE");
    const declared = await readJson(
      json("{}", { headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) } }),
    );
    expect(declared.ok ? null : declared.error.code).toBe("TOO_LARGE");
    expect(respond(streamed).status).toBe(413);
  });
});

describe("respond", () => {
  it("maps every ContractError code through HTTP_STATUS with a { error } body", async () => {
    for (const code of ERROR_CODES) {
      const res = respond(err(code, "x"));
      expect(res.status).toBe(HTTP_STATUS[code]);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("returns values with the requested status and no-store caching", async () => {
    const res = respond(ok({ id: 1 }), 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: 1 });
  });
});

describe("query parsing", () => {
  it("accepts revision numbers >= 1 and rejects others", () => {
    const req = (q: string) => new Request(`http://localhost/x?revision=${q}`);
    expect(readQuery(req("3"), "revision", RevisionNumberQuery)).toEqual({ ok: true, value: 3 });
    for (const bad of ["0", "-1", "1.5", "abc", "01"])
      expect(readQuery(req(bad), "revision", RevisionNumberQuery).ok).toBe(false);
  });
});

describe("api handlers (reference backend)", () => {
  it("answers 401 before validating anything for anonymous callers", async () => {
    const ctx = memoryContext(null);
    expect((await api.createProject(ctx, json("{not json"))).status).toBe(401);
    expect((await api.getProject(ctx, "not-an-id")).status).toBe(401);
    expect((await api.listProjects(ctx)).status).toBe(401);
  });

  it("validates bodies with parseContract (422 INVALID_SCHEMA with issues)", async () => {
    const res = await api.createProject(memoryContext("user_a"), json({ projectId: "nope" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_SCHEMA");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it("rejects malformed path IDs and body/URL mismatches", async () => {
    const ctx = memoryContext("user_a");
    expect((await api.getProject(ctx, "../etc")).status).toBe(422);
    const projectId = newId("project");
    const takeId = newId("take");
    const manifest = retargetedFixture({ projectId, takeId, assetId: newId("asset") });
    const res = await api.saveRevision(
      ctx,
      json({ projectId, takeId, expectedRevision: 1, manifest, idempotencyKey: "key-12345678", message: null }),
      newId("project"),
      takeId,
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/projectId in the body does not match/);
  });

  it("creates a project (201) and reads it back; another user gets 404", async () => {
    const backend = Object.assign(new MemoryBackend(), { listProjects: async () => ok([]) });
    const owner: api.ApiContext = { backend, actor: { userId: "user_a" } };
    const other: api.ApiContext = { backend, actor: { userId: "user_b" } };
    const projectId = newId("project");
    const full = retargetedFixture({ projectId, takeId: newId("take"), assetId: newId("asset") });
    const initialManifest = { ...full, scene: { ...full.scene, objects: [] } };
    const created = await api.createProject(
      owner,
      json({ projectId, title: "HTTP test", initialManifest, idempotencyKey: "key-abcdefgh" }),
    );
    expect(created.status).toBe(201);
    expect((await api.getProject(owner, projectId)).status).toBe(200);
    const hidden = await api.getProject(other, projectId);
    expect(hidden.status).toBe(404);
    expect((await hidden.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("cookie session read", () => {
  it("reads cookies without consuming the request body (regression: locked stream on cookie POSTs)", async () => {
    const request = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "sb-test-auth-token=abc; other=1" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(requestCookieJar(request).getAll()).toEqual([
      { name: "sb-test-auth-token", value: "abc" },
      { name: "other", value: "1" },
    ]);
    expect(await readJson(request)).toEqual({ ok: true, value: { hello: "world" } });
  });
});

describe("safeNext", () => {
  it("allows same-origin paths only", () => {
    expect(safeNext("/projects/new")).toBe("/projects/new");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "projects", "/\t/evil.example", "/\n/evil.example", "/a\\b", "/\u0000x"])
      expect(safeNext(bad), JSON.stringify(bad)).toBe("/projects");
    expect(safeNext("/projects/prj_1?take=2#top")).toBe("/projects/prj_1?take=2#top");
  });
});
