import type { FastifyInstance } from "fastify";
import { redactObject } from "../../security/secret-redaction.js";
import type { PresentationCatalogService } from "../presentation/presentation-catalog-service.js";

interface RouteParams {
  id: string;
}

/**
 * Registers the product-facing Usage catalog reads.
 *
 * Every read below is served from Router canonical truth with Usage
 * intelligence attached. The legacy `VisibilityStore` is deliberately absent:
 * Router owns effective route visibility, so no read may consult SQLite
 * visibility preferences.
 */
export function registerCatalogRoutes(
  fastify: FastifyInstance,
  catalog: PresentationCatalogService,
): void {
  fastify.get("/v1/cmm/usage/catalog/providers", async () =>
    redactObject({ data: await catalog.listProviders() }),
  );

  fastify.get("/v1/cmm/usage/catalog/routes", async () =>
    redactObject({ data: await catalog.listRoutes() }),
  );

  fastify.get("/v1/cmm/usage/catalog/quotas", async () =>
    redactObject({ data: await catalog.listQuotaSummaries() }),
  );

  fastify.get<{ Params: RouteParams }>("/v1/cmm/usage/catalog/routes/:id", async (request, reply) => {
    const route = await catalog.getRoute(request.params.id);
    if (route === undefined) {
      return reply.code(404).send({
        error: {
          type: "usage_catalog_route_not_found",
          message: "Catalog route not found",
        },
      });
    }
    return redactObject(route);
  });

  fastify.get("/v1/cmm/usage/catalog/promotions", async () =>
    redactObject({ data: await catalog.listPromotions() }),
  );

  // Compatibility view: reports Router effective visibility, not SQLite
  // preferences, so a route hidden from every consumer surface reads as hidden
  // even when a legacy preference row disagrees.
  fastify.get("/v1/cmm/usage/catalog/visibility", async () =>
    redactObject({ data: await catalog.listRouteVisibility() }),
  );
}
