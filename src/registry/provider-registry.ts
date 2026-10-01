import type { ProviderAdapter, DiscoveredModel } from "../core/provider.js";
import { RouterError } from "../core/errors.js";

const DISCOVERY_CACHE_TTL_MS = 30_000;

/**
 * How many consecutive *successful* discoveries must report an empty catalog
 * before the previously known models of that source are retired.
 *
 * A runtime that is restarting, still warming up, or briefly answering an empty
 * body is indistinguishable, from one sample, from a runtime whose models were
 * genuinely uninstalled.  Requiring two consecutive empty answers separates the
 * two without guessing: a real removal is still observed on the next refresh,
 * while a single transient empty answer can never erase a known catalog.
 */
const EMPTY_RETIREMENT_CONFIRMATIONS = 2;

/**
 * The lifecycle state of one catalog source.
 *
 * `available`   discovery succeeded and the listed models are the current ones.
 * `unavailable` discovery failed, or the runtime answered empty; the retained
 *               descriptors are kept with their identity and marked unusable.
 * `never_seen`  the source has never produced a successful discovery, so there
 *               is nothing truthful to retain.
 */
export type SourceStatus = "available" | "unavailable" | "never_seen";

export interface SourceSnapshot {
  readonly providerId: string;
  readonly status: SourceStatus;
  readonly models: readonly DiscoveredModel[];
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly consecutiveEmptyResults: number;
  /** A bounded, secret-free reason. Never upstream text. */
  readonly detail: string | null;
}

interface CachedDiscovery {
  models: DiscoveredModel[];
  timestamp: number;
  /** The newest discovery attempt, successful or not. */
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  consecutiveEmptyResults: number;
  error?: Error;
}

function boundedDetail(error: Error): string {
  return error.message.slice(0, 200);
}

/**
 * Registry of the provider adapters and their discovered catalogs.
 *
 * Reconciliation is **source-aware**: each source owns its own retained
 * descriptors, so a failure in one source can never empty another, and a
 * failure in one source never empties its own known catalog either.  A
 * transient discovery failure marks the retained models unavailable — it never
 * converts "known" into "empty".
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderAdapter>();
  private discoveryCache = new Map<string, CachedDiscovery>();

  getAdapter(providerId: string): ProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Registered provider route ids in registration order. Identity comes from
   * the runtime registry (what is actually routable), never from a separate
   * inventory list.
   */
  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  async register(adapter: ProviderAdapter): Promise<void> {
    this.providers.set(adapter.id, adapter);
  }

  async refresh(): Promise<void> {
    await Promise.allSettled(
      [...this.providers.keys()].map((id) => this.refreshOne(id)),
    );
  }

  /**
   * Re-discover only the sources whose cached result has aged past the TTL.
   *
   * The read path calls this so `/v1/models` is never a frozen boot snapshot:
   * a model the account gains while the Router is running becomes visible
   * without a restart.  A source whose discovery is still fresh is untouched,
   * so a polling reader never spawns provider runtimes.
   */
  async refreshStale(now: number = Date.now()): Promise<void> {
    await Promise.allSettled(
      [...this.providers.keys()]
        .filter((id) => this.isStale(id, now))
        .map((id) => this.refreshOne(id, now)),
    );
  }

  private isStale(id: string, now: number): boolean {
    const cached = this.discoveryCache.get(id);
    if (cached === undefined) return true;
    return now - cached.lastAttemptAt > DISCOVERY_CACHE_TTL_MS;
  }

  /**
   * Discover one source and reconcile its result against what was known.
   *
   * The three outcomes are deliberately distinct:
   *   success with models  → adopt, clear the empty counter
   *   success, empty       → retain until confirmed twice, then retire
   *   failure              → retain always, mark unavailable
   */
  private async refreshOne(id: string, now: number = Date.now()): Promise<void> {
    const adapter = this.providers.get(id);
    if (adapter === undefined) return;
    const previous = this.discoveryCache.get(id);

    try {
      const models = await adapter.discoverModels();
      if (models.length === 0) {
        const empties = (previous?.consecutiveEmptyResults ?? 0) + 1;
        const confirmed = empties >= EMPTY_RETIREMENT_CONFIRMATIONS;
        this.discoveryCache.set(id, {
          // Retained until an empty answer is confirmed; a single empty
          // response from a starting or restarting runtime changes nothing.
          models: confirmed ? [] : [...(previous?.models ?? [])],
          timestamp: now,
          lastAttemptAt: now,
          lastSuccessAt: now,
          consecutiveEmptyResults: empties,
        });
        return;
      }
      this.discoveryCache.set(id, {
        models: [...models],
        timestamp: now,
        lastAttemptAt: now,
        lastSuccessAt: now,
        consecutiveEmptyResults: 0,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.discoveryCache.set(id, {
        // The whole point: a failed refresh retains the last known catalog.
        // An empty list here would tell a client that models it has been
        // showing no longer exist, which a transient outage cannot establish.
        models: [...(previous?.models ?? [])],
        timestamp: now,
        lastAttemptAt: now,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        consecutiveEmptyResults: previous?.consecutiveEmptyResults ?? 0,
        error: failure,
      });
    }
  }

  listModels(): DiscoveredModel[] {
    const allModels: DiscoveredModel[] = [];
    for (const [id, cached] of this.discoveryCache) {
      allModels.push(...this.project(id, cached));
    }
    return allModels;
  }

  /**
   * One snapshot per registered source, for diagnostics and for a catalog read
   * that must report provenance rather than a flat list.
   */
  listSources(): SourceSnapshot[] {
    return [...this.providers.keys()].map((id) => {
      const cached = this.discoveryCache.get(id);
      if (cached === undefined) {
        return {
          providerId: id,
          status: "never_seen" as const,
          models: [],
          lastSuccessAt: null,
          lastAttemptAt: null,
          consecutiveEmptyResults: 0,
          detail: null,
        };
      }
      return {
        providerId: id,
        status: this.statusOf(id, cached),
        models: this.project(id, cached),
        lastSuccessAt: cached.lastSuccessAt,
        lastAttemptAt: cached.lastAttemptAt,
        consecutiveEmptyResults: cached.consecutiveEmptyResults,
        detail: cached.error ? boundedDetail(cached.error) : null,
      };
    });
  }

  private statusOf(id: string, cached: CachedDiscovery): SourceStatus {
    if (cached.error !== undefined) return "unavailable";
    if (cached.consecutiveEmptyResults > 0) return "unavailable";
    return cached.lastSuccessAt === null ? "never_seen" : "available";
  }

  /**
   * Project a source's retained models, stamping the source's current state
   * onto each one so a retained descriptor is never presented as usable.
   */
  private project(id: string, cached: CachedDiscovery): DiscoveredModel[] {
    const healthy = this.statusOf(id, cached) === "available";
    return cached.models.map((model) => ({
      ...model,
      // A provider's health says whether its source is reachable; it cannot
      // turn a model the account itself restricts (usage credits, say) back
      // into something the catalog offers, so a model-level verdict wins.
      availability: model.availability ?? (healthy ? "available" : "unavailable"),
    }));
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

    if (this.isStale(providerId, Date.now())) {
      await this.refreshOne(providerId);
    }

    const currentCache = this.discoveryCache.get(providerId);

    if (currentCache === undefined) {
      throw new RouterError(
        "unknown_model",
        `Model not found: ${modelId}`,
        { modelId, provider: providerId },
      );
    }

    // A model that is still part of the retained catalog resolves even when the
    // newest discovery failed: the failure says the *listing* could not be
    // refreshed, not that the route is gone.  The run itself fails closed with
    // the provider's own error if the route really is down.
    const model = currentCache.models.find((m) => m.id === modelId);
    if (model) {
      return { ...model, availability: this.statusOf(providerId, currentCache) === "available" ? "available" : "unavailable" };
    }

    // Not in the retained catalog. Only now is a discovery error the honest
    // answer: a source that has never discovered successfully must report why
    // it cannot serve, not a bare "unknown model".
    if (currentCache.error !== undefined) {
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

    throw new RouterError(
      "unknown_model",
      `Model not found: ${modelId}`,
      { modelId, provider: providerId },
    );
  }
}
