import type { FastifyInstance } from "fastify";
import {
  buildRouterCatalogProjection,
  type RouterCatalogProjectionInput,
} from "../catalog/projection.js";

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
