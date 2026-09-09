import Fastify, { type FastifyInstance } from "fastify";
import { verifyBearer } from "../security/bearer-auth.js";
import { ProviderRegistry } from "../registry/provider-registry.js";
import { registerDiagnostics } from "./diagnostics.js";
import { registerChatCompletions } from "./openai-chat.js";
import { redactObject } from "../security/secret-redaction.js";

export interface ServerOptions {
  host: string;
  port: number;
  bearerSecret: string;
  registry: ProviderRegistry;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const fastify = Fastify({
    logger: false,
  });

  // Bearer auth pre-handler for /v1/* routes
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      const authorization = request.headers.authorization;
      const isValid = verifyBearer(authorization, options.bearerSecret);

      if (!isValid) {
        return reply.code(401).send({
          error: {
            type: "router_unauthorized",
            message: "Invalid or missing bearer token",
          },
        });
      }
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
  registerDiagnostics(fastify, options.registry);

  // OpenAI-compatible chat completions
  registerChatCompletions(fastify, options.registry);

  return fastify;
}
