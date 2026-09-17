import type {
  AccessRoute,
  Account,
  CostEvent,
  OperationalIdentityRef,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  SubscriptionPeriod,
  UsageEvent,
} from "../domain/types.js";
import { UsageAdapterManager } from "../adapters/adapter-manager.js";
import type {
  CostEventBatch,
  QuotaSnapshotBatch,
  UsageAdapter,
  UsageAdapterHealth,
  UsageAdapterManifest,
  UsageDiscoveryResult,
  UsageEventBatch,
  UsageRefreshResult,
} from "../adapters/contract.js";
import { UsageService, type UsageServiceOptions } from "../service/usage-service.js";
import type { UsageStore } from "../storage/usage-store.js";

export interface UsageIntegrationDefinition {
  id: string;
  type: string;
  enabled: boolean;
  credentialRef?: string;
  settings: Readonly<Record<string, unknown>>;
}

/**
 * Canonical Router identity binding for one Usage collector.
 *
 * Produced from the Router projection and Router administration state (the
 * `observabilityBindingId` is the explicit observability credential binding
 * that authorizes collection). A collector receives this instead of
 * constructing current operational IDs of its own.
 *
 * Collector enablement is deliberately *not* part of this object: a provider
 * may be executable-but-not-collected, collected-but-not-executable, both, or
 * neither, and those states must stay explicit.
 */
export interface UsageCollectorBinding extends OperationalIdentityRef {
  integrationId: string;
  routeIds: string[];
  observabilityBindingId?: string;
}

export interface UsageRuntimeConfig {
  integrations: readonly UsageIntegrationDefinition[];
  /**
   * Canonical Router identity bindings, keyed by Usage integration id.
   *
   * Supplied by the composition that owns Router truth. A binding without an
   * `observabilityBindingId` is configured but not authorized to collect, so
   * the collector stays disabled rather than inferring permission to observe.
   */
  bindings?: readonly UsageCollectorBinding[];
}

export type UsageIntegrationFactory = (
  definition: UsageIntegrationDefinition,
  binding?: UsageCollectorBinding,
) => UsageAdapter;

export class UsageIntegrationCatalog {
  private readonly factories = new Map<string, UsageIntegrationFactory>();

  register(type: string, factory: UsageIntegrationFactory): void {
    if (this.factories.has(type)) throw new Error(`Duplicate usage integration type: ${type}`);
    this.factories.set(type, factory);
  }

  create(
    definition: UsageIntegrationDefinition,
    binding?: UsageCollectorBinding,
  ): UsageAdapter {
    const factory = this.factories.get(definition.type);
    if (factory === undefined) throw new Error(`Unsupported usage integration type: ${definition.type}`);
    return factory(definition, binding);
  }

  types(): string[] {
    return [...this.factories.keys()].sort();
  }
}

function scopedId(id: string, instanceId: string): string {
  return `${id}@${encodeURIComponent(instanceId)}`;
}

/**
 * Instance isolation for collectors that supply their own operational IDs.
 *
 * Two instances of the same integration must not collide in Usage SQLite, so
 * their account/route observations are namespaced per instance. A collector
 * bound to canonical Router identities is exempt: its IDs already come from
 * Router (distinct connections and routes per instance) and must be stored
 * verbatim so the Usage rows join back to the canonical Router route.
 */
class InstanceScopedUsageAdapter implements UsageAdapter {
  readonly id: string;

  constructor(
    private readonly inner: UsageAdapter,
    private readonly instanceId: string,
    private readonly scopeInstanceIdentities: boolean,
  ) {
    this.id = inner.id;
  }

  manifest(): UsageAdapterManifest {
    return this.inner.manifest();
  }

  capabilities() {
    return this.inner.capabilities();
  }

  health(): Promise<UsageAdapterHealth> {
    return this.inner.health();
  }

  private scoped(id: string): string {
    return this.scopeInstanceIdentities ? scopedId(id, this.instanceId) : id;
  }

  private account(value: Account): Account {
    return { ...value, id: this.scoped(value.id) };
  }

  private subscription(value: SubscriptionPeriod): SubscriptionPeriod {
    return {
      ...value,
      id: this.scoped(value.id),
      accountId: this.scoped(value.accountId),
    };
  }

  private route(value: AccessRoute): AccessRoute {
    return {
      ...value,
      id: this.scoped(value.id),
      accountId: this.scoped(value.accountId),
      ...(value.subscriptionPeriodId === undefined
        ? {}
        : { subscriptionPeriodId: this.scoped(value.subscriptionPeriodId) }),
    };
  }

  private bucket(value: QuotaBucket): QuotaBucket {
    return {
      ...value,
      id: this.scoped(value.id),
      accountId: this.scoped(value.accountId),
    };
  }

  private binding(value: QuotaBinding): QuotaBinding {
    return {
      ...value,
      id: this.scoped(value.id),
      accessRouteId: this.scoped(value.accessRouteId),
      quotaBucketId: this.scoped(value.quotaBucketId),
    };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const result = await this.inner.discover();
    if (result.status !== "ok") return result;
    return {
      ...result,
      accounts: result.accounts.map((value) => this.account(value)),
      accessRoutes: result.accessRoutes.map((value) => this.route(value)),
      ...(result.subscriptionPeriods === undefined
        ? {}
        : { subscriptionPeriods: result.subscriptionPeriods.map((value) => this.subscription(value)) }),
      ...(result.quotaBuckets === undefined
        ? {}
        : { quotaBuckets: result.quotaBuckets.map((value) => this.bucket(value)) }),
      ...(result.quotaBindings === undefined
        ? {}
        : { quotaBindings: result.quotaBindings.map((value) => this.binding(value)) }),
    };
  }

  private usageEvent(value: UsageEvent): UsageEvent {
    return {
      ...value,
      id: this.scoped(value.id),
      accountId: this.scoped(value.accountId),
      ...(value.accessRouteId === undefined
        ? {}
        : { accessRouteId: this.scoped(value.accessRouteId) }),
    };
  }

  async collectUsageEvents(cursor?: string): Promise<UsageEventBatch> {
    const result = await this.inner.collectUsageEvents(cursor);
    if (result.status !== "ok") return result;
    return { ...result, values: result.values.map((value) => this.usageEvent(value)) };
  }

  private snapshot(value: QuotaSnapshot): QuotaSnapshot {
    return {
      ...value,
      id: this.scoped(value.id),
      quotaBucketId: this.scoped(value.quotaBucketId),
    };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    const result = await this.inner.collectQuotaSnapshots();
    if (result.status !== "ok") return result;
    return { ...result, values: result.values.map((value) => this.snapshot(value)) };
  }

  private costEvent(value: CostEvent): CostEvent {
    return {
      ...value,
      id: this.scoped(value.id),
      accountId: this.scoped(value.accountId),
      ...(value.accessRouteId === undefined
        ? {}
        : { accessRouteId: this.scoped(value.accessRouteId) }),
    };
  }

  async collectCostEvents(cursor?: string): Promise<CostEventBatch> {
    const result = await this.inner.collectCostEvents(cursor);
    if (result.status !== "ok") return result;
    return { ...result, values: result.values.map((value) => this.costEvent(value)) };
  }

  refresh(): Promise<UsageRefreshResult> {
    return this.inner.refresh();
  }
}

interface ActiveIntegration {
  definitionKey: string;
  adapter: UsageAdapter;
}

function definitionKey(
  definition: UsageIntegrationDefinition,
  binding: UsageCollectorBinding | undefined,
): string {
  return JSON.stringify({
    type: definition.type,
    credentialRef: definition.credentialRef,
    settings: definition.settings,
    binding,
  });
}

export class ConfiguredUsageRuntime {
  readonly adapters = new UsageAdapterManager();
  readonly service: UsageService;
  private readonly active = new Map<string, ActiveIntegration>();
  private readonly bindings = new Map<string, UsageCollectorBinding>();

  constructor(
    store: UsageStore,
    private readonly catalog: UsageIntegrationCatalog,
    options: UsageServiceOptions = {},
  ) {
    this.service = new UsageService(store, this.adapters, options);
  }

  /**
   * Canonical Router identity bindings currently configured, in configuration
   * order. Reported independently of collector enablement so the two states
   * stay explicit.
   */
  collectorBindings(): UsageCollectorBinding[] {
    return [...this.bindings.values()];
  }

  async applyConfig(config: UsageRuntimeConfig): Promise<void> {
    const configuredIds = new Set(config.integrations.map(({ id }) => id));
    if (configuredIds.size !== config.integrations.length) {
      throw new Error("Usage integration ids must be unique");
    }

    const bindings = new Map<string, UsageCollectorBinding>();
    for (const binding of config.bindings ?? []) {
      if (!configuredIds.has(binding.integrationId)) {
        throw new Error(
          `Usage collector binding references an unconfigured integration: ${binding.integrationId}`,
        );
      }
      if (bindings.has(binding.integrationId)) {
        throw new Error("Usage collector bindings must be unique per integration");
      }
      bindings.set(binding.integrationId, binding);
    }

    for (const [id] of this.active) {
      if (!configuredIds.has(id)) {
        this.adapters.setEnabled(id, false);
        this.service.clearCollectorBinding(id);
      }
    }

    for (const definition of config.integrations) {
      const binding = bindings.get(definition.id);
      if (binding === undefined) this.service.clearCollectorBinding(definition.id);
      else this.service.bindCollector(definition.id, binding);

      // Collector enablement is its own axis. Router connection enablement is
      // never consulted here, and a binding only authorizes collection when it
      // carries an explicit observability binding.
      const collectable = binding === undefined || binding.observabilityBindingId !== undefined;
      const existing = this.active.get(definition.id);
      if (!definition.enabled || !collectable) {
        if (existing !== undefined) this.adapters.setEnabled(definition.id, false);
        continue;
      }

      const key = definitionKey(definition, binding);
      if (existing === undefined || existing.definitionKey !== key) {
        const adapter = new InstanceScopedUsageAdapter(
          this.catalog.create(definition, binding),
          definition.id,
          binding === undefined,
        );
        this.adapters.register(adapter, true, definition.id);
        this.active.set(definition.id, { definitionKey: key, adapter });
      } else {
        this.adapters.setEnabled(definition.id, true);
      }
    }

    this.bindings.clear();
    for (const [id, binding] of bindings) this.bindings.set(id, binding);
  }
}
