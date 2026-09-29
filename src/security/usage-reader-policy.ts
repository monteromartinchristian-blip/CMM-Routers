import type { FastifyRequest } from "fastify";
import { verifyBearer } from "./bearer-auth.js";
import type { RouterErrorCode } from "../core/errors.js";
import type { ConsumerId } from "../core/consumer-capability.js";

/**
 * Environment variable holding the read-only observability bearer.
 *
 * This is the Router-side *name* only — mirroring `QODER_TOKEN_ENV`, the value
 * never lives in a tracked file, in CLI arguments or in logs; the launch
 * wrapper exports it into the process environment at start-up.
 */
export const USAGE_READER_TOKEN_ENV = "CMM_USAGE_READER_TOKEN";

/**
 * The read-only principal identity.
 *
 * It is a distinct principal kind and deliberately NOT part of `ConsumerId`.
 * Consumers are inference clients (CMMChat / Qoder), and the only readers of
 * `request.consumerId` are the chat and responses handlers. A usage-reader
 * request is therefore never given a consumer identity at all: there is no
 * value for an inference handler to trust, so no path exists by which the
 * read-only bearer can authorize an inference.
 */
export const USAGE_READER_PRINCIPAL = "usage-reader";

export type UsageReaderPrincipal = typeof USAGE_READER_PRINCIPAL;

/**
 * Marks a request authenticated as the read-only principal. Both fields are
 * optional and mutually exclusive: exactly one is set on an authenticated
 * `/v1/*` request, and `consumerId` must stay absent for a read-only one.
 */
export interface PrincipalRequest extends FastifyRequest {
  consumerId?: ConsumerId;
  principalKind?: UsageReaderPrincipal;
}

/**
 * Emitted when a valid read-only bearer presents a route it may not use.
 *
 * 403 (`router_forbidden`) means "you are who you say you are, and this is
 * still not yours"; 401 (`router_unauthorized`) means "you are not
 * authenticated". Keeping them apart is what makes a privilege-probing client
 * observable instead of indistinguishable from a mistyped token.
 */
export const READ_ONLY_FORBIDDEN_ERROR: RouterErrorCode = "router_forbidden";

/**
 * One entry of the read-only allowlist: an exact HTTP method plus the exact
 * route pattern as registered on the Fastify instance.
 */
export interface ReadOnlyRoute {
  readonly method: "GET";
  readonly path: string;
}

/**
 * The complete authorization surface of the read-only principal.
 *
 * This is an EXPLICIT ALLOWLIST, not a `/v1/cmm/*` prefix. A prefix would
 * silently grant every future route mounted under the diagnostics namespace —
 * administration surfaces such as catalog connection creation, custom endpoint
 * registration, credential and routing-state mutations — the moment somebody
 * registers them. The observability client reads exactly these two routes, so
 * these are the only two identities that can be authorized; widening the
 * boundary has to be a visible edit to this list plus its tests.
 *
 * Routes are matched on their *registered* pattern, so a parameterised route
 * such as `/v1/cmm/catalog/:id` is a different identity and stays denied.
 */
export const READ_ONLY_ROUTES: readonly ReadOnlyRoute[] = [
  { method: "GET", path: "/v1/cmm/health" },
  { method: "GET", path: "/v1/cmm/catalog" },
];

/**
 * True only for an exact `(method, registered route pattern)` pair from
 * `READ_ONLY_ROUTES`.
 *
 * `routePath` is the pattern Fastify actually matched, never the raw URL:
 * query strings and path-normalization tricks either resolve to the canonical
 * pattern or fail to match a route at all. An unresolvable route (`undefined`,
 * i.e. the 404 context) is denied rather than guessed at — fail closed.
 */
export function isReadOnlyRouteAllowed(method: string, routePath: string | undefined): boolean {
  if (routePath === undefined) return false;
  return READ_ONLY_ROUTES.some(
    (route) => route.method === method && route.path === routePath,
  );
}

/**
 * Does this request present the configured read-only bearer?
 *
 * Unconfigured (`undefined` or blank) means the principal simply cannot
 * authenticate: every such request falls through to the ordinary consumer
 * path and answers 401, exactly as before this boundary existed.
 */
export function presentsUsageReaderToken(
  request: FastifyRequest,
  usageReaderToken: string | undefined,
): boolean {
  if (usageReaderToken === undefined || usageReaderToken.length === 0) return false;
  return verifyBearer(request.headers.authorization, usageReaderToken);
}

/** Tag a request as the read-only principal. Never sets `consumerId`. */
export function markUsageReaderPrincipal(request: FastifyRequest): void {
  (request as PrincipalRequest).principalKind = USAGE_READER_PRINCIPAL;
}

/** Whether a request was authenticated as the read-only principal. */
export function isUsageReaderRequest(request: FastifyRequest): boolean {
  return (request as PrincipalRequest).principalKind === USAGE_READER_PRINCIPAL;
}
