import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ProviderRegistry } from "../registry/provider-registry.js";
import { registerDiagnostics } from "./diagnostics.js";
import { registerChatCompletions } from "./openai-chat.js";
import { registerResponsesApi } from "./openai-responses.js";
import type { UsageStore } from "../observability/usage-store.js";
import { redactObject } from "../security/secret-redaction.js";
import type { RouterProfile } from "../core/router-profile.js";
import {
  CLIENT_ID_HEADER,
  assertDistinctServerTokens,
  resolveRequestIdentity,
  type ResolvedIdentity,
  type ServerTokens,
} from "./identity.js";

export interface ServerOptions {
  host: string;
  port: number;
  /** Bearer for the CMMChat profile (permanently CHAT_ONLY). */
  bearerSecret: string;
  registry: ProviderRegistry;
  usageStore?: UsageStore;
  /**
   * Canonical Code Router bearer. Requests presenting it authenticate the Code
   * Router profile, whose effective capability is the intersection of the
   * profile and the resolved provider/model capability.
   */
  codeRouterToken?: string;
  /**
   * @deprecated Legacy Code Router bearer. It authenticates the SAME Code
   * Router profile and is retained so existing installations keep working
   * during the compatibility window. No client identity grants capability.
   */
  qoderToken?: string;
}

export type ConsumerRequest = FastifyRequest & {
  identity: ResolvedIdentity;
  /**
   * @deprecated Derived from `identity.profile`; retained for compatibility.
   */
  consumerId: RouterProfile;
};

function serverTokens(
  options: Pick<ServerOptions, "bearerSecret" | "codeRouterToken" | "qoderToken">,
): ServerTokens {
  return {
    cmmchatToken: options.bearerSecret,
    ...(options.codeRouterToken !== undefined ? { codeRouterToken: options.codeRouterToken } : {}),
    ...(options.qoderToken !== undefined ? { legacyQoderToken: options.qoderToken } : {}),
  };
}

/**
 * @deprecated Use `resolveRequestIdentity`. Retained as a thin compatibility
 * wrapper that returns the resolved profile.
 */
export function resolveConsumerId(
  request: FastifyRequest,
  options: Pick<ServerOptions, "bearerSecret" | "codeRouterToken" | "qoderToken">,
): RouterProfile | null {
  const clientHeader = request.headers[CLIENT_ID_HEADER];
  const identity = resolveRequestIdentity(
    request.headers.authorization,
    serverTokens(options),
    typeof clientHeader === "string" ? clientHeader : undefined,
  );
  return identity === null ? null : identity.profile;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  // Fail closed at startup: a configuration in which one secret could
  // authenticate two different profiles is rejected rather than silently
  // resolved to CMMChat at request time.
  assertDistinctServerTokens(serverTokens(options));

  const fastify = Fastify({
    logger: false,
    // Headroom over the 1 MiB tool-result policy so an at-bound result plus
    // its JSON envelope is not rejected by the framework first; the explicit
    // tool-result bound (core/tool-result-bound.ts) is the binding policy.
    bodyLimit: 2 * 1024 * 1024,
  });

  // Bearer auth pre-handler for /v1/* routes. The authenticated PROFILE is the
  // authorization subject: CMMChat (always CHAT_ONLY) or the Code Router
  // profile. A request authenticates as exactly one profile; anything else is
  // 401. Profile identity is never inferred from prompt text, User-Agent,
  // model names, or any request-supplied metadata — the optional application
  // identifier is diagnostics only.
  fastify.addHook("preHandler", async (request: FastifyRequest, reply) => {
    if (request.url.startsWith("/v1/")) {
      const clientHeader = request.headers[CLIENT_ID_HEADER];
      const identity = resolveRequestIdentity(
        request.headers.authorization,
        serverTokens(options),
        typeof clientHeader === "string" ? clientHeader : undefined,
      );
      if (identity === null) {
        return reply.code(401).send({
          error: {
            type: "router_unauthorized",
            message: "Invalid or missing bearer token",
          },
        });
      }
      const consumerRequest = request as ConsumerRequest;
      consumerRequest.identity = identity;
      consumerRequest.consumerId = identity.profile;
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

  // OpenAI-compatible models endpoint. The standard model shape is preserved
  // exactly; a namespaced `x_cmm` extension is added ONLY when the Router
  // already knows the model's Code Router capability verdict, so a generic
  // client can select an exact CHAT_AND_TOOLS model without relying on model
  // names or provider heuristics. Unknown extra fields are ignored by
  // ordinary OpenAI-compatible clients. Publication is a fact about the
  // model, never an authorization grant.
  fastify.get("/v1/models", async () => {
    const models = options.registry.listModels();
    return redactObject({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: `cmm:${model.provider}`,
        ...(model.capability !== undefined
          ? { x_cmm: { code_router: model.capability } }
          : {}),
      })),
    });
  });

  // Diagnostic endpoints
  registerDiagnostics(fastify, options.registry, options.usageStore);

  // OpenAI-compatible chat completions. Tool semantics are gated on the
  // authenticated profile via effectiveProfileToolCapability.
  registerChatCompletions(fastify, options.registry, options.usageStore);

  // OpenAI-compatible responses API
  registerResponsesApi(fastify, options.registry, options.usageStore);

  return fastify;
}
