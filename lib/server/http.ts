/**
 * HTTP edge for the platform API: JSON bodies in, Result values out.
 *
 * - Only `application/json` bodies (415 UNSUPPORTED_MEDIA otherwise). This
 *   also forces a CORS preflight for cross-site scripts, and the Supabase
 *   session cookie is SameSite=Lax, so cookie-authenticated writes cannot be
 *   triggered by another site's form.
 * - Bodies are metadata only, capped at MAX_BODY_BYTES (413 TOO_LARGE).
 *   Media goes to signed storage URLs, never through these handlers.
 * - Every error is a ContractError with its status from HTTP_STATUS.
 */
import type { z } from "zod";
import { HTTP_STATUS, err, ok, parseContract, type Result } from "@/lib/contracts/common";

export const MAX_BODY_BYTES = 1024 * 1024;

const NO_STORE = { "cache-control": "no-store" };

/** Serialize a Result: value with `status`, or `{ error }` with its mapped status. */
export function respond<T>(result: Result<T>, status = 200): Response {
  if (result.ok) return Response.json(result.value, { status, headers: NO_STORE });
  return Response.json({ error: result.error }, { status: HTTP_STATUS[result.error.code], headers: NO_STORE });
}

/** Read a bounded JSON body. */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Result<unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type))
    return err("UNSUPPORTED_MEDIA", "request body must be application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return err("TOO_LARGE", `request body exceeds ${maxBytes} bytes`, { maxBytes });
  if (!request.body) return err("INVALID_SCHEMA", "request body is empty");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return err("TOO_LARGE", `request body exceeds ${maxBytes} bytes`, { maxBytes });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return ok(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return err("INVALID_SCHEMA", "request body is not valid JSON");
  }
}

/** Read a JSON body and validate it against a contract schema. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<Result<z.output<S>>> {
  const body = await readJson(request);
  if (!body.ok) return body;
  return parseContract(schema, body.value);
}

/** Validate one query-string parameter (missing is an INVALID_SCHEMA issue). */
export function readQuery<S extends z.ZodType>(request: Request, name: string, schema: S): Result<z.output<S>> {
  const value = new URL(request.url).searchParams.get(name);
  const parsed = parseContract(schema, value ?? undefined);
  if (parsed.ok) return parsed;
  return err("INVALID_SCHEMA", `query parameter "${name}" is missing or invalid`, {
    issues: [{ path: name, message: value === null ? "required" : "invalid value" }],
  });
}

/** Validate a path segment; a malformed ID is an INVALID_SCHEMA issue. */
export function readParam<S extends z.ZodType>(name: string, value: string, schema: S): Result<z.output<S>> {
  const parsed = parseContract(schema, value);
  if (parsed.ok) return parsed;
  return err("INVALID_SCHEMA", `path parameter "${name}" is invalid`, {
    issues: [{ path: name, message: "invalid value" }],
  });
}

/** The body must address the same resource as the URL. */
export function matchPath(field: string, bodyValue: string, pathValue: string): Result<true> {
  if (bodyValue === pathValue) return ok(true);
  return err("INVALID_SCHEMA", `${field} in the body does not match the URL`, {
    issues: [{ path: field, message: `expected ${pathValue}` }],
  });
}
