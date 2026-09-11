import type { ProviderAdapter, DiscoveredModel } from "../core/provider.js";
import { RouterError } from "../core/errors.js";

const DISCOVERY_CACHE_TTL_MS = 30_000;

interface CachedDiscovery {
  models: DiscoveredModel[];
  timestamp: number;
  error?: Error;
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderAdapter>();
  private discoveryCache = new Map<string, CachedDiscovery>();

  getAdapter(providerId: string): ProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  async register(adapter: ProviderAdapter): Promise<void> {
    this.providers.set(adapter.id, adapter);
  }

  async refresh(): Promise<void> {
    const discoveries: Array<Promise<void>> = [];

    for (const [id, adapter] of this.providers) {
      discoveries.push(
        (async () => {
          try {
            const models = await adapter.discoverModels();
            this.discoveryCache.set(id, {
              models,
              timestamp: Date.now(),
            });
          } catch (error) {
            this.discoveryCache.set(id, {
              models: [],
              timestamp: Date.now(),
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        })(),
      );
    }

    await Promise.allSettled(discoveries);
  }

  listModels(): DiscoveredModel[] {
    const allModels: DiscoveredModel[] = [];

    for (const [, cached] of this.discoveryCache) {
      allModels.push(...cached.models);
    }

    return allModels;
  }

  async getProviderHealth(signal?: AbortSignal): Promise<Map<string, import("../core/provider.js").ProviderHealth>> {
    const healthMap = new Map<string, import("../core/provider.js").ProviderHealth>();

    const healthChecks: Array<Promise<void>> = [];

    for (const [id, adapter] of this.providers) {
      healthChecks.push(
        (async () => {
          try {
            const health = await adapter.health(signal);
            healthMap.set(id, health);
          } catch (error) {
            healthMap.set(id, {
              status: "unavailable",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        })(),
      );
    }

    await Promise.allSettled(healthChecks);

    return healthMap;
  }

  async resolve(modelId: string): Promise<DiscoveredModel> {
    const slashIndex = modelId.indexOf("/");
    if (slashIndex === -1) {
      throw new RouterError(
        "unknown_provider",
        `Invalid model ID format: ${modelId}`,
        { modelId },
      );
    }

    const providerId = modelId.slice(0, slashIndex);
    const adapter = this.providers.get(providerId);

    if (!adapter) {
      throw new RouterError(
        "unknown_provider",
        `Unknown provider: ${providerId}`,
        { providerId },
      );
    }

    const cached = this.discoveryCache.get(providerId);
    const isStale = !cached || Date.now() - cached.timestamp > DISCOVERY_CACHE_TTL_MS;

    if (isStale) {
      try {
        const models = await adapter.discoverModels();
        this.discoveryCache.set(providerId, {
          models,
          timestamp: Date.now(),
        });
      } catch (error) {
        this.discoveryCache.set(providerId, {
          models: [],
          timestamp: Date.now(),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    const currentCache = this.discoveryCache.get(providerId);

    // If discovery previously failed, preserve the error
    if (currentCache?.error) {
      const cachedError = currentCache.error;
      if (cachedError instanceof RouterError) {
        throw cachedError;
      }
      throw new RouterError(
        "provider_unavailable",
        `Provider discovery failed: ${providerId}`,
        { provider: providerId, error: cachedError.message },
      );
    }

    if (!currentCache?.models.length) {
      throw new RouterError(
        "unknown_model",
        `Model not found: ${modelId}`,
        { modelId, provider: providerId },
      );
    }

    const model = currentCache.models.find((m) => m.id === modelId);
    if (!model) {
      throw new RouterError(
        "unknown_model",
        `Model not found: ${modelId}`,
        { modelId, provider: providerId },
      );
    }

    return model;
  }
}
