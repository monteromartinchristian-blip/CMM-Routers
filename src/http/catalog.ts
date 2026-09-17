import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  buildRouterCatalogProjection,
  type RouterCatalogProjectionInput,
} from "../catalog/projection.js";
import type {
  AddCustomEndpointInput,
  ConnectProviderInput,
  RouterAdministrationService,
} from "../catalog/router-administration-service.js";
import { verifyBearer } from "../security/bearer-auth.js";
import { redactObject } from "../security/secret-redaction.js";

const routeSurfaceSchema = z.enum([
  "cmmchat_model_picker",
  "cmmcode_model_picker",
  "admin_console",
]);

const connectSchema = z
  .object({
    providerId: z.string().min(1),
    connectionId: z.string().min(1),
    connectionKind: z.string().min(1),
    secret: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    profileRef: z.string().min(1).optional(),
    endpointRef: z.string().min(1).optional(),
    authorizeExecution: z.boolean(),
    authorizeObservability: z.boolean(),
  })
  .strict();

const connectionStateSchema = z.object({ enabled: z.boolean() }).strict();

const customEndpointSchema = z
  .object({
    connectionId: z.string().min(1),
    displayName: z.string().min(1),
    endpointUrl: z.string().url(),
    apiKey: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    visibleOn: z.array(routeSurfaceSchema).optional(),
  })
  .strict();

const routeVisibilitySchema = z
  .object({ visibleOn: z.array(routeSurfaceSchema) })
  .strict();

/**
 * Privileged Router administration paths. These are distinct from the
 * read-only `GET /v1/cmm/catalog` projection, which keeps its own read
 * authentication; a privileged credential is never required to read.
 */
export function isRouterAdministrationPath(url: string): boolean {
  return /^\/v1\/cmm\/catalog\/(?:connections(?:\/|\?|$)|custom-endpoints(?:\/|\?|$)|routes(?:\/|\?|$))/.test(
    url,
  );
}

export function registerManagementCatalog(
  fastify: FastifyInstance,
  input: RouterCatalogProjectionInput,
  beforeRead?: () => Promise<void>,
): void {
  fastify.get("/v1/cmm/catalog", async () => {
    await beforeRead?.();
    return buildRouterCatalogProjection(input);
  });
}

function authorized(
  request: FastifyRequest,
  reply: FastifyReply,
  managementToken: string,
): boolean {
  if (verifyBearer(request.headers.authorization, managementToken)) return true;
  void reply.code(401).send({
    error: {
      type: "router_administration_unauthorized",
      message: "Invalid or missing router administration credential",
    },
  });
  return false;
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      type: "router_administration_invalid_request",
      message: "Invalid router administration request",
    },
  });
}

/**
 * Classifies a RouterAdministrationService failure into a safe response.
 * The raw message is never echoed because it can contain request-supplied
 * identifiers; only a stable, secret-free summary is returned.
 */
function rejected(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^Unknown (?:provider|connection|route):/u.test(message)) {
    return reply.code(404).send({
      error: {
        type: "router_administration_unknown_target",
        message: "Unknown router administration target",
      },
    });
  }
  if (/reconciliation failed/iu.test(message)) {
    return reply.code(502).send({
      error: {
        type: "router_administration_reconciliation_failed",
        message: "Router catalog reconciliation failed",
      },
    });
  }
  return reply.code(400).send({
    error: {
      type: "router_administration_rejected",
      message: "Router administration request rejected",
    },
  });
}

/**
 * Router-owned privileged administration surface. Every handler validates its
 * body with Zod and delegates to `RouterAdministrationService` only: it never
 * touches Usage storage, the Usage visibility store, or connection-management
 * compatibility services. Responses carry safe summaries, never the request
 * secret or a secure credential reference.
 */
export function registerRouterAdministration(
  fastify: FastifyInstance,
  administration: RouterAdministrationService,
  managementToken: string,
): void {
  fastify.post("/v1/cmm/catalog/connections", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const value = parsed.data;
    const input: ConnectProviderInput = {
      providerId: value.providerId,
      connectionId: value.connectionId,
      connectionKind: value.connectionKind,
      authorizeExecution: value.authorizeExecution,
      authorizeObservability: value.authorizeObservability,
      ...(value.secret === undefined ? {} : { secret: value.secret }),
      ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
      ...(value.productId === undefined ? {} : { productId: value.productId }),
      ...(value.profileRef === undefined ? {} : { profileRef: value.profileRef }),
      ...(value.endpointRef === undefined ? {} : { endpointRef: value.endpointRef }),
    };
    try {
      return redactObject(await administration.connect(input));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.patch<{ Params: { connectionId: string } }>(
    "/v1/cmm/catalog/connections/:connectionId",
    async (request, reply) => {
      if (!authorized(request, reply, managementToken)) return;
      const parsed = connectionStateSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        return redactObject(
          await administration.setEnabled(
            request.params.connectionId,
            parsed.data.enabled,
          ),
        );
      } catch (error) {
        return rejected(reply, error);
      }
    },
  );

  fastify.delete<{ Params: { connectionId: string } }>(
    "/v1/cmm/catalog/connections/:connectionId",
    async (request, reply) => {
      if (!authorized(request, reply, managementToken)) return;
      try {
        await administration.disconnect(request.params.connectionId);
      } catch (error) {
        return rejected(reply, error);
      }
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { connectionId: string } }>(
    "/v1/cmm/catalog/connections/:connectionId/validate",
    async (request, reply) => {
      if (!authorized(request, reply, managementToken)) return;
      try {
        return redactObject(await administration.validate(request.params.connectionId));
      } catch (error) {
        return rejected(reply, error);
      }
    },
  );

  fastify.post<{ Params: { connectionId: string } }>(
    "/v1/cmm/catalog/connections/:connectionId/refresh",
    async (request, reply) => {
      if (!authorized(request, reply, managementToken)) return;
      try {
        return redactObject(
          await administration.refreshModels(request.params.connectionId),
        );
      } catch (error) {
        return rejected(reply, error);
      }
    },
  );

  fastify.post("/v1/cmm/catalog/custom-endpoints", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = customEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const value = parsed.data;
    const input: AddCustomEndpointInput = {
      connectionId: value.connectionId,
      displayName: value.displayName,
      endpointUrl: value.endpointUrl,
      ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
      ...(value.defaultModel === undefined ? {} : { defaultModel: value.defaultModel }),
      ...(value.visibleOn === undefined ? {} : { visibleOn: value.visibleOn }),
    };
    try {
      return redactObject(await administration.addCustomEndpoint(input));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.patch<{ Params: { routeId: string } }>(
    "/v1/cmm/catalog/routes/:routeId/visibility",
    async (request, reply) => {
      if (!authorized(request, reply, managementToken)) return;
      const parsed = routeVisibilitySchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        return redactObject(
          await administration.setRouteVisibility(
            request.params.routeId,
            parsed.data.visibleOn,
          ),
        );
      } catch (error) {
        return rejected(reply, error);
      }
    },
  );
}
