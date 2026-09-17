import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { redactObject } from "../../security/secret-redaction.js";
import type { ConnectionManagementService } from "../service/connection-management-service.js";
import { verifyUsageManagementBearer } from "./connection-auth.js";

const connectSchema = z.object({
  integrationType: z.string().min(1),
  instanceId: z.string().min(1).optional(),
  secret: z.string().min(1),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

const customEndpointSchema = z.object({
  instanceId: z.string().min(1).optional(),
  name: z.string().min(1),
  endpointUrl: z.string().url(),
  defaultModel: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  discoverModels: z.boolean().optional(),
  useInCmmChat: z.boolean().optional(),
  usageEndpoint: z.string().min(1).optional(),
  billingEndpoint: z.string().min(1).optional(),
  quotaMode: z.enum(["automatic", "manual", "unknown"]).optional(),
}).strict();

const stateSchema = z.object({ action: z.enum(["enable", "disable"]) }).strict();
const visibilitySchema = z.object({
  routeId: z.string().min(1),
  state: z.enum(["visible", "hidden", "inherit"]),
}).strict();

function authorized(
  request: FastifyRequest,
  reply: FastifyReply,
  managementToken: string,
): boolean {
  if (verifyUsageManagementBearer(request.headers.authorization, managementToken)) return true;
  void reply.code(401).send({
    error: {
      type: "usage_management_unauthorized",
      message: "Invalid or missing CMM Usage management credential",
    },
  });
  return false;
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      type: "usage_invalid_request",
      message: "Invalid CMM Usage connection request",
    },
  });
}

/**
 * Classifies a compatibility delegate failure into a safe response.
 *
 * The raw error message is never echoed: it can contain request-supplied
 * identifiers, and every mutation now runs inside Router administration. An
 * absent Router administration authority (for example a demo composition with
 * no canonical Router graph) reports 503 rather than a bare 500.
 */
function rejected(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^Unknown (?:router provider|connection|route):/u.test(message)) {
    return reply.code(404).send({
      error: {
        type: "usage_connection_unknown_target",
        message: "Unknown CMM Usage connection target",
      },
    });
  }
  if (/is unavailable$/u.test(message)) {
    return reply.code(503).send({
      error: {
        type: "usage_connection_authority_unavailable",
        message: "CMM Usage connection authority is unavailable",
      },
    });
  }
  return reply.code(400).send({
    error: {
      type: "usage_connection_rejected",
      message: "CMM Usage connection request rejected",
    },
  });
}

export function registerConnectionRoutes(
  fastify: FastifyInstance,
  connections: ConnectionManagementService,
  managementToken: string,
): void {
  fastify.post("/v1/cmm/usage/connections/api-key", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { integrationType, secret, instanceId, settings } = parsed.data;
    try {
      return redactObject(await connections.connectWithApiKey(integrationType, secret, {
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(settings === undefined ? {} : { settings }),
      }));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.post("/v1/cmm/usage/connections/account", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { integrationType, secret, instanceId, settings } = parsed.data;
    try {
      return redactObject(await connections.connectAccount(integrationType, secret, {
        ...(instanceId === undefined ? {} : { instanceId }),
        ...(settings === undefined ? {} : { settings }),
      }));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.post("/v1/cmm/usage/connections/custom-endpoint", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = customEndpointSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const value = parsed.data;
    try {
      return redactObject(await connections.addCustomEndpoint({
        name: value.name,
        endpointUrl: value.endpointUrl,
        ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
        ...(value.defaultModel === undefined ? {} : { defaultModel: value.defaultModel }),
        ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
        ...(value.discoverModels === undefined ? {} : { discoverModels: value.discoverModels }),
        ...(value.useInCmmChat === undefined ? {} : { useInCmmChat: value.useInCmmChat }),
        ...(value.usageEndpoint === undefined ? {} : { usageEndpoint: value.usageEndpoint }),
        ...(value.billingEndpoint === undefined ? {} : { billingEndpoint: value.billingEndpoint }),
        ...(value.quotaMode === undefined ? {} : { quotaMode: value.quotaMode }),
      }));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.patch<{ Params: { id: string } }>("/v1/cmm/usage/connections/:id", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = stateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      return redactObject(parsed.data.action === "enable"
        ? await connections.enable(request.params.id)
        : await connections.disable(request.params.id));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.delete<{ Params: { id: string } }>("/v1/cmm/usage/connections/:id", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    try {
      await connections.disconnect(request.params.id);
    } catch (error) {
      return rejected(reply, error);
    }
    return reply.code(204).send();
  });

  fastify.post<{ Params: { id: string } }>("/v1/cmm/usage/connections/:id/test", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    try {
      return redactObject(await connections.testConnection(request.params.id));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.post<{ Params: { id: string } }>("/v1/cmm/usage/connections/:id/refresh", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    try {
      return redactObject(await connections.refresh(request.params.id));
    } catch (error) {
      return rejected(reply, error);
    }
  });

  fastify.patch("/v1/cmm/usage/catalog/visibility", async (request, reply) => {
    if (!authorized(request, reply, managementToken)) return;
    const parsed = visibilitySchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      await connections.setVisibility({
        scope: "global",
        routeId: parsed.data.routeId,
        state: parsed.data.state,
      });
    } catch (error) {
      return rejected(reply, error);
    }
    return { routeId: parsed.data.routeId, state: parsed.data.state };
  });
}
