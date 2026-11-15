/**
 * Adapter from Next Route Handlers to lib/server/api handlers: resolves the
 * actor and backend per request and turns unexpected failures (database or
 * network down) into a 503 ContractError instead of an HTML error page.
 */
import { err } from "@/lib/contracts/common";
import type { ApiContext, PlatformBackend, StorageGateway } from "./api";
import { getActor } from "./auth";
import { getBackend } from "./backend";
import { respond } from "./http";

type Params = Record<string, string>;

interface RouteOverrides {
  backend?: PlatformBackend;
  storage?: StorageGateway;
}

let overrides: RouteOverrides = {};

/**
 * Test seam: run the real route modules against a chosen backend (e.g. the
 * test database) and storage gateway. Actor resolution is never overridden;
 * requests still authenticate with real tokens. Call with {} to reset.
 */
export function setRouteContextForTests(next: RouteOverrides) {
  overrides = next;
}

export function route<P extends Params = Params>(
  handler: (ctx: ApiContext, request: Request, params: P) => Promise<Response>,
) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    try {
      const params = await context.params;
      const ctx: ApiContext = {
        backend: overrides.backend ?? getBackend(),
        actor: await getActor(request),
        storage: overrides.storage,
      };
      return await handler(ctx, request, params);
    } catch (error) {
      console.error(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, error);
      return respond(err("PROVIDER_UNAVAILABLE", "the platform backend is temporarily unavailable"));
    }
  };
}
