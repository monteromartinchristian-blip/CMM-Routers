import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import { redactObject } from "../security/secret-redaction.js";

export function registerDiagnostics(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
): void {
  fastify.get("/v1/cmm/providers", async () => {
    const models = registry.listModels();
    const providers = new Set(models.map((m) => m.provider));

    return redactObject({
      providers: Array.from(providers).map((id) => ({
        id,
        modelCount: models.filter((m) => m.provider === id).length,
      })),
    });
  });

  fastify.get("/v1/cmm/health", async () => {
    return redactObject({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get("/v1/cmm/usage", async () => {
    return redactObject({
      requestCount: 0,
      note: "Usage tracking not yet implemented",
    });
  });
}
