import type { FastifyInstance } from "fastify";
import {
  buildRouterCatalogProjection,
  type RouterCatalogProjectionInput,
} from "../catalog/projection.js";

export function registerManagementCatalog(
  fastify: FastifyInstance,
  input: RouterCatalogProjectionInput,
): void {
  fastify.get("/v1/cmm/catalog", async () => {
    return buildRouterCatalogProjection(input);
  });
}
