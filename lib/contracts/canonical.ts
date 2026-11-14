/**
 * Deterministic JSON and hashing shared by browser and server, so the same
 * manifest always produces the same `sha256:` hash everywhere.
 */

/** JSON with object keys sorted recursively. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** `sha256:<hex>` of raw bytes (Web Crypto; Node 22+ and browsers). */
export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/** Hash of a JSON value's canonical form. */
export function hashJson(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

/** Deep copy of JSON-compatible data (stored documents are immutable). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
