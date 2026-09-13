import type { FastifyInstance } from "fastify";
import { redactObject } from "../../security/secret-redaction.js";
import type { UsageService } from "../service/usage-service.js";

interface RefreshBody {
  adapterId?: unknown;
}

export function registerUsageRoutes(fastify: FastifyInstance, service: UsageService): void {
  fastify.get("/v1/cmm/usage", async () => redactObject(await service.queries.getOverview()));

  fastify.get("/v1/cmm/usage/providers", async () =>
    redactObject({ data: await service.queries.listProviders() }),
  );

  fastify.get("/v1/cmm/usage/products", async () =>
    redactObject({ data: await service.queries.listProducts() }),
  );

  fastify.get("/v1/cmm/usage/models", async () =>
    redactObject({ data: await service.queries.listModels() }),
  );

  fastify.get("/v1/cmm/usage/routes", async () =>
    redactObject({ data: await service.queries.listRoutes() }),
  );

  fastify.get("/v1/cmm/usage/quotas", async () =>
    redactObject({ data: await service.queries.listQuotas() }),
  );

  fastify.get("/v1/cmm/usage/history", async () =>
    redactObject({ data: await service.queries.listHistory() }),
  );

  fastify.get("/v1/cmm/usage/costs", async () =>
    redactObject({ data: await service.queries.listCosts() }),
  );

  fastify.get("/v1/cmm/usage/subscriptions", async () =>
    redactObject({ data: await service.queries.listSubscriptions() }),
  );

  fastify.get("/v1/cmm/usage/alerts", async () =>
    redactObject({ data: await service.queries.listAlerts() }),
  );

  fastify.post("/v1/cmm/usage/refresh-all", async () =>
    redactObject(await service.refreshAll()),
  );

  fastify.post<{ Body: RefreshBody }>("/v1/cmm/usage/refresh", async (request, reply) => {
    const adapterId = request.body?.adapterId;
    if (typeof adapterId !== "string" || adapterId.length === 0) {
      return reply.code(400).send({
        error: {
          type: "usage_invalid_request",
          message: "adapterId must be a non-empty string",
        },
      });
    }
    return redactObject(await service.refresh(adapterId));
  });
}
