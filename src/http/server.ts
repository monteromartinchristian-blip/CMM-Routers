import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { verifyBearer } from "../security/bearer-auth.js";
import {
  isReadOnlyRouteAllowed,
  markUsageReaderPrincipal,
  presentsUsageReaderToken,
  READ_ONLY_FORBIDDEN_ERROR,
} from "../security/usage-reader-policy.js";
import { ProviderRegistry } from "../registry/provider-registry.js";
import { registerDiagnostics } from "./diagnostics.js";
import { registerCatalogRead } from "./catalog.js";
import { registerChatCompletions } from "./openai-chat.js";
import { registerResponsesApi } from "./openai-responses.js";
import type { UsageStore } from "../observability/usage-store.js";
import { redactObject } from "../security/secret-redaction.js";
import {
  CONSUMER_CMMCHAT,
  CONSUMER_QODER,
  type ConsumerId,
} from "../core/consumer-capability.js";

export interface ServerOptions {
  host: string;
  port: number;
  bearerSecret: string;
  registry: ProviderRegistry;
  usageStore?: UsageStore;
  /**
   * Optional second bearer token bound to the Qoder consumer. When absent
   * there is no Qoder consumer and every authenticated client is CMMChat
   * (permanently CHAT_ONLY). Server-side and configuration-controlled: a
   * client can never enable tools by itself, and CMMChat can never use them.
   */
  qoderToken?: string;
  /**
   * Optional bearer for the read-only observability principal (CMM Usage).
   * Supplied only through `USAGE_READER_TOKEN_ENV` (see
   * security/usage-reader-policy.ts) and never by a client claim.
   *
   * This is a third principal kind, not a consumer: it can never be resolved
   * to a `ConsumerId`, and it is authorized for the explicit route allowlist
   * only. When absent the principal cannot authenticate at all and every
   * request behaves exactly as it did before this option existed.
   */
  usageReaderToken?: string;
}

export type ConsumerRequest = FastifyRequest & { consumerId: ConsumerId };

export function resolveConsumerId(
  request: FastifyRequest,
  options: Pick<ServerOptions, "bearerSecret" | "qoderToken">,
): ConsumerId | null {
  const authorization = request.headers.authorization;
  if (verifyBearer(authorization, options.bearerSecret)) return CONSUMER_CMMCHAT;
  if (options.qoderToken !== undefined && verifyBearer(authorization, options.qoderToken)) {
    return CONSUMER_QODER;
  }
  return null;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    // Headroom over the 1 MiB tool-result policy so an at-bound result plus
    // its JSON envelope is not rejected by the framework first; the explicit
    // tool-result bound (core/tool-result-bound.ts) is the binding policy.
    bodyLimit: 2 * 1024 * 1024,
  });

  // Bearer auth pre-handler for /v1/* routes. Three configured server-side
  // secrets exist: the default consumer (CMMChat, always CHAT_ONLY), the
  // optional Qoder consumer token, and the optional read-only observability
  // bearer. A request authenticates as exactly one principal; anything else
  // is 401. Principal identity is never inferred from prompt text, User-Agent,
  // model names or any other client-supplied claim.
  fastify.addHook("preHandler", async (request: FastifyRequest, reply) => {
    // A request is on the authenticated surface if either the raw URL or the
    // route the router actually resolved is under /v1. The raw URL alone is
    // not enough: the router percent-decodes before matching, so a request for
    // "/%761/chat/completions" reaches the chat route while a raw-prefix test
    // would skip this whole block. Route identity is not enough either, because
    // an unmatched URL has no identity to consult. Taking the union keeps every
    // legitimate route's behaviour identical and closes the encoded variant.
    const routeIdentity = request.routeOptions?.url;
    const onProtectedSurface =
      request.url.startsWith("/v1/") ||
      (routeIdentity !== undefined && routeIdentity.startsWith("/v1/"));

    if (onProtectedSurface) {
      // The read-only principal is resolved BEFORE the consumers on purpose.
      // If an operator ever configures the same secret for both, the narrower
      // grant wins and the request cannot reach inference; ordering must never
      // be able to upgrade a read-only bearer into a consumer.
      if (presentsUsageReaderToken(request, options.usageReaderToken)) {
        // Authorization is decided on the route pattern Fastify matched (not
        // the raw URL) against an explicit allowlist, so mounting a new route
        // under /v1/cmm/* grants the read-only principal nothing.
        if (!isReadOnlyRouteAllowed(request.method, routeIdentity)) {
          // Authenticated, but outside the read-only boundary: 403 with a
          // distinct code so probing is observable and never mistaken for a
          // bad token.
          return reply.code(403).send({
            error: {
              type: READ_ONLY_FORBIDDEN_ERROR,
              message: "Read-only principal is not authorized for this route",
            },
          });
        }
        // Tagged, and deliberately NOT given a consumerId: a request without
        // one can never satisfy an inference handler's consumer lookup.
        markUsageReaderPrincipal(request);
        return;
      }

      const consumerId = resolveConsumerId(request, options);
      if (consumerId === null) {
        return reply.code(401).send({
          error: {
            type: "router_unauthorized",
            message: "Invalid or missing bearer token",
          },
        });
      }
      (request as ConsumerRequest).consumerId = consumerId;
    }
  });

  // Health endpoint (unauthenticated on loopback)
  fastify.get("/health", async () => {
    return { status: "ok" };
  });

  // Ready endpoint
  fastify.get("/ready", async (_request, reply) => {
    const healthMap = await options.registry.getProviderHealth();
    
    // Check if at least one registered provider is ready
    let hasReadyProvider = false;
    for (const [, health] of healthMap) {
      if (health.status === "ready") {
        hasReadyProvider = true;
        break;
      }
    }
    
    if (!hasReadyProvider) {
      return reply.code(503).send({
        status: "not_ready",
        reason: "No providers available",
      });
    }
    
    return { status: "ready" };
  });

  // OpenAI-compatible models endpoint.
  //
  // Staleness is reconciled on read so this route is never a frozen boot
  // snapshot: a model the account gains while the Router is running becomes
  // visible without a restart, and a model a source no longer advertises
  // disappears on its own. Only sources whose cached result has aged past the
  // TTL are re-discovered, so a polling reader never spawns provider runtimes.
  fastify.get("/v1/models", async () => {
    await options.registry.refreshStale();
    const models = options.registry.listModels();
    return redactObject({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: model.vendor ?? `cmm:${model.provider}`,
        // Descriptor truth, carried only when the upstream actually declared
        // it. An absent field is an honest unknown; it is never filled in from
        // the id's spelling.
        ...(model.displayName ? { display_name: model.displayName } : {}),
        ...(model.version ? { version: model.version } : {}),
        ...(model.locality ? { locality: model.locality } : {}),
        ...(model.availability ? { availability: model.availability } : {}),
        ...(model.reasoningEfforts ? { reasoning_efforts: [...model.reasoningEfforts] } : {}),
      })),
    });
  });

  // Diagnostic endpoints
  registerDiagnostics(fastify, options.registry, options.usageStore);

  // Read-only catalog projection (GET /v1/cmm/catalog). Registered like every
  // other route here — from the runtime registry, for every built server — so
  // the read is always present for the principals the pre-handler above
  // admits: the consumers, and the read-only observability principal whose
  // allowlist names this exact route identity.
  registerCatalogRead(fastify, options.registry);

  // OpenAI-compatible chat completions. Tool semantics are gated per consumer
  // (CMMChat vs Qoder) inside the handler via effectiveToolCapability.
  registerChatCompletions(fastify, options.registry, options.usageStore);

  // OpenAI-compatible responses API
  registerResponsesApi(fastify, options.registry, options.usageStore);

  return fastify;
}
