import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { verifyBearer } from "../security/bearer-auth.js";
import { ProviderRegistry } from "../registry/provider-registry.js";
import { registerDiagnostics } from "./diagnostics.js";
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

  // Bearer auth pre-handler for /v1/* routes. Two configured server-side
  // tokens exist: the default (CMMChat, always CHAT_ONLY) and the optional
  // Qoder token. A request authenticates as exactly one consumer; anything
  // else is 401. Consumer identity is never inferred from prompt text,
  // User-Agent, or model names.
  fastify.addHook("preHandler", async (request: FastifyRequest, reply) => {
    if (request.url.startsWith("/v1/")) {
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

  // OpenAI-compatible models endpoint
  fastify.get("/v1/models", async () => {
    const models = options.registry.listModels();
    return redactObject({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: `cmm:${model.provider}`,
      })),
    });
  });

  // Diagnostic endpoints
  registerDiagnostics(fastify, options.registry, options.usageStore);

  // OpenAI-compatible chat completions. Tool semantics are gated per consumer
  // (CMMChat vs Qoder) inside the handler via effectiveToolCapability.
  registerChatCompletions(fastify, options.registry, options.usageStore);

  // OpenAI-compatible responses API
  registerResponsesApi(fastify, options.registry, options.usageStore);

  return fastify;
}
