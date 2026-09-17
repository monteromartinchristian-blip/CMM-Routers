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
import type { CatalogRuntimeBridge } from "../catalog/runtime-bridge.js";
import type { RouterCatalogProjectionInput } from "../catalog/projection.js";
import type { RouterAdministrationService } from "../catalog/router-administration-service.js";
import {
  isRouterAdministrationPath,
  registerManagementCatalog,
  registerRouterAdministration,
} from "./catalog.js";
import type { UsageService as CmmUsageService } from "../usage/service/usage-service.js";
import { isUsageApiPath, verifyUsageBearer } from "../usage/api/usage-auth.js";
import { registerUsageRoutes } from "../usage/api/usage-routes.js";
import { registerCatalogRoutes } from "../usage/api/catalog-routes.js";
import type { PresentationCatalogService } from "../usage/presentation/presentation-catalog-service.js";
import type { VisibilityStore } from "../usage/presentation/visibility-store.js";
import type { RouterTelemetrySink } from "../usage/service/router-telemetry-bridge.js";
import type { ConnectionManagementService } from "../usage/service/connection-management-service.js";
import { isUsageMutationPath, verifyUsageManagementBearer } from "../usage/api/connection-auth.js";
import { registerConnectionRoutes } from "../usage/api/connection-routes.js";

export interface ServerOptions {
  host: string;
  port: number;
  bearerSecret: string;
  registry: ProviderRegistry;
  usageStore?: UsageStore;
  runtimeBridge?: CatalogRuntimeBridge;
  catalogProjectionInput?: RouterCatalogProjectionInput;
  beforeCatalogRead?: () => Promise<void>;
  /**
   * Optional second bearer token bound to the Qoder consumer. When absent
   * there is no Qoder consumer and every authenticated client is CMMChat
   * (permanently CHAT_ONLY). Server-side and configuration-controlled: a
   * client can never enable tools by itself, and CMMChat can never use them.
   */
  qoderToken?: string;
  /** Read-only credential scoped to the CMM Usage API surface. */
  usageToken?: string;
  /**
   * Privileged credential authorizing Router administrative mutation
   * (connections, custom endpoints and exact-route visibility). While the CMM
   * Usage compatibility endpoints still exist, the same credential also
   * authorizes CMM Usage connection/visibility mutation, which delegates to
   * Router administration. It is never a read credential.
   */
  usageManagementToken?: string;
  /**
   * Router-owned administration service backing privileged
   * `/v1/cmm/catalog/**` mutation. Constructed from the same canonical Router
   * graph used by execution; there is never a second Router state graph.
   */
  routerAdministration?: RouterAdministrationService;
  /** Canonical CMM Usage service. When present it owns /v1/cmm/usage*. */
  cmmUsageService?: CmmUsageService;
  /** Preserved product-facing Usage catalog WIP. */
  cmmUsageCatalog?: PresentationCatalogService;
  /** Preserved Usage visibility WIP; authority migration follows reconciliation. */
  cmmUsageVisibility?: VisibilityStore;
  /** Preserved Usage connection-management WIP; authority migration follows reconciliation. */
  cmmUsageConnections?: ConnectionManagementService;
  /** Optional sink for normalized inference consumption metadata. */
  routerTelemetry?: RouterTelemetrySink;
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
  if (
    options.usageToken !== undefined &&
    (options.usageToken === options.bearerSecret || options.usageToken === options.qoderToken)
  ) {
    throw new Error("Usage bearer token must be distinct from inference bearer tokens");
  }
  if (
    options.usageManagementToken !== undefined &&
    (options.usageManagementToken === options.bearerSecret ||
      options.usageManagementToken === options.qoderToken ||
      options.usageManagementToken === options.usageToken)
  ) {
    throw new Error("Usage management token must be distinct from read and inference bearer tokens");
  }

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
      const managementCredential = verifyUsageManagementBearer(
        request.headers.authorization,
        options.usageManagementToken,
      );
      if (managementCredential) {
        if (options.cmmUsageConnections !== undefined && isUsageMutationPath(request.url)) return;
        if (
          options.routerAdministration !== undefined &&
          isRouterAdministrationPath(request.url)
        ) {
          return;
        }
        return reply.code(403).send({
          error: {
            type: "management_scope_forbidden",
            message: "Privileged credential is restricted to mutation endpoints",
          },
        });
      }

      const usageCredential = verifyUsageBearer(request.headers.authorization, options.usageToken);
      if (usageCredential) {
        if (options.cmmUsageService !== undefined && isUsageApiPath(request.url)) return;
        return reply.code(403).send({
          error: {
            type: "usage_scope_forbidden",
            message: "Usage credential is restricted to the CMM Usage API",
          },
        });
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
  registerDiagnostics(
    fastify,
    options.registry,
    options.usageStore,
    options.cmmUsageService === undefined,
  );

  if (options.catalogProjectionInput !== undefined) {
    registerManagementCatalog(
      fastify,
      options.catalogProjectionInput,
      options.beforeCatalogRead,
    );
  }
  if (
    options.routerAdministration !== undefined &&
    options.usageManagementToken !== undefined
  ) {
    registerRouterAdministration(
      fastify,
      options.routerAdministration,
      options.usageManagementToken,
    );
  }

  if (options.cmmUsageService !== undefined) {
    registerUsageRoutes(fastify, options.cmmUsageService);
  }
  if (options.cmmUsageCatalog !== undefined && options.cmmUsageVisibility !== undefined) {
    registerCatalogRoutes(fastify, options.cmmUsageCatalog, options.cmmUsageVisibility);
  }
  if (
    options.cmmUsageConnections !== undefined &&
    options.usageManagementToken !== undefined
  ) {
    registerConnectionRoutes(fastify, options.cmmUsageConnections, options.usageManagementToken);
  }

  // OpenAI-compatible chat completions. Tool semantics are gated per consumer
  // (CMMChat vs Qoder) inside the handler via effectiveToolCapability.
  registerChatCompletions(
    fastify,
    options.registry,
    options.usageStore,
    options.runtimeBridge,
    options.routerTelemetry,
  );

  // OpenAI-compatible responses API
  registerResponsesApi(
    fastify,
    options.registry,
    options.usageStore,
    options.runtimeBridge,
    options.routerTelemetry,
  );

  return fastify;
}
