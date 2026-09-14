import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { UsageStore } from "../observability/usage-store.js";
import type { ProviderId } from "../core/model.js";
import { providerInventory } from "../providers/manifests.js";
import { redactObject } from "../security/secret-redaction.js";

/** Billing/identity metadata for a registered route, when it is a wave provider. */
function billingMetadataFor(providerId: string) {
  return providerInventory().find((entry) => entry.providerId === (providerId as ProviderId));
}

export function registerDiagnostics(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
  usageStore?: UsageStore,
): void {
  fastify.get("/v1/cmm/providers", async () => {
    const models = registry.listModels();

    return redactObject({
      // Registered routes come from the runtime registry; billing class,
      // credential namespace, tool capability and activation scope are
      // PROJECTED from the single manifest catalog. No credit or balance figure
      // is claimed: the router reports routability (catalog + activation), and
      // money state lives in the provider's own billing surface.
      providers: registry.listProviderIds().map((id) => {
        const billing = billingMetadataFor(id);
        return {
          id,
          modelCount: models.filter((model) => model.provider === id).length,
          ...(billing === undefined
            ? {}
            : {
                displayName: billing.displayName,
                billingClass: billing.billingClass,
                credentialEnv: billing.credentialEnv,
                toolCapability: billing.toolCapability,
                activationMode: billing.activationMode,
              }),
        };
      }),
    });
  });

  fastify.get("/v1/cmm/health", async () => {
    const healthMap = await registry.getProviderHealth();
    const providers: Array<{ id: string; status: string; detail?: string }> = [];
    
    for (const [id, health] of healthMap) {
      providers.push({
        id,
        status: health.status,
        ...(health.detail && { detail: health.detail }),
      });
    }

    return redactObject({
      status: "ok",
      timestamp: new Date().toISOString(),
      providers,
    });
  });

  fastify.get("/v1/cmm/usage", async () => {
    if (!usageStore) {
      return redactObject({
        status: "disabled",
        totalRequests: 0,
        recent: [],
      });
    }
    const aggregates = usageStore.aggregates();
    return redactObject({
      status: "ok",
      totalRequests: aggregates.totalRequests,
      successCount: aggregates.successCount,
      failureCount: aggregates.failureCount,
      activeRequests: aggregates.activeRequests,
      activeModel: aggregates.activeModel,
      averageLatencyMs: aggregates.averageLatencyMs,
      lastSuccessAt: aggregates.lastSuccessAt,
      quotaEvents: aggregates.quotaEvents,
      // Account-state blocks are reported separately from spent-allowance
      // (quota) and rate-limit events: only settlement clears a block.
      billingBlockedEvents: aggregates.billingBlockedEvents,
      rateLimitEvents: aggregates.rateLimitEvents,
      timeoutEvents: aggregates.timeoutEvents,
      cancelledEvents: aggregates.cancelledEvents,
      recent: usageStore.listRecent(20),
    });
  });
}
