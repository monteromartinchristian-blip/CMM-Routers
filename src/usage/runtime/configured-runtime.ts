import type {
  AccessRoute,
  Account,
  CostEvent,
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

export interface UsageRuntimeConfig {
  integrations: readonly UsageIntegrationDefinition[];
}

export type UsageIntegrationFactory = (definition: UsageIntegrationDefinition) => UsageAdapter;

export class UsageIntegrationCatalog {
  private readonly factories = new Map<string, UsageIntegrationFactory>();

  register(type: string, factory: UsageIntegrationFactory): void {
    if (this.factories.has(type)) throw new Error(`Duplicate usage integration type: ${type}`);
    this.factories.set(type, factory);
  }

  create(definition: UsageIntegrationDefinition): UsageAdapter {
    const factory = this.factories.get(definition.type);
    if (factory === undefined) throw new Error(`Unsupported usage integration type: ${definition.type}`);
    return factory(definition);
  }

  types(): string[] {
    return [...this.factories.keys()].sort();
  }
}

function scopedId(id: string, instanceId: string): string {
  return `${id}@${encodeURIComponent(instanceId)}`;
}

class InstanceScopedUsageAdapter implements UsageAdapter {
  readonly id: string;

  constructor(
    private readonly inner: UsageAdapter,
    private readonly instanceId: string,
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

  private account(value: Account): Account {
    return { ...value, id: scopedId(value.id, this.instanceId) };
  }

  private subscription(value: SubscriptionPeriod): SubscriptionPeriod {
    return {
      ...value,
      id: scopedId(value.id, this.instanceId),
      accountId: scopedId(value.accountId, this.instanceId),
    };
  }

  private route(value: AccessRoute): AccessRoute {
    return {
      ...value,
      id: scopedId(value.id, this.instanceId),
      accountId: scopedId(value.accountId, this.instanceId),
      ...(value.subscriptionPeriodId === undefined
        ? {}
        : { subscriptionPeriodId: scopedId(value.subscriptionPeriodId, this.instanceId) }),
    };
  }

  private bucket(value: QuotaBucket): QuotaBucket {
    return {
      ...value,
      id: scopedId(value.id, this.instanceId),
      accountId: scopedId(value.accountId, this.instanceId),
    };
  }

  private binding(value: QuotaBinding): QuotaBinding {
    return {
      ...value,
      id: scopedId(value.id, this.instanceId),
      accessRouteId: scopedId(value.accessRouteId, this.instanceId),
      quotaBucketId: scopedId(value.quotaBucketId, this.instanceId),
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
      id: scopedId(value.id, this.instanceId),
      accountId: scopedId(value.accountId, this.instanceId),
      ...(value.accessRouteId === undefined
        ? {}
        : { accessRouteId: scopedId(value.accessRouteId, this.instanceId) }),
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
      id: scopedId(value.id, this.instanceId),
      quotaBucketId: scopedId(value.quotaBucketId, this.instanceId),
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
      id: scopedId(value.id, this.instanceId),
      accountId: scopedId(value.accountId, this.instanceId),
      ...(value.accessRouteId === undefined
        ? {}
        : { accessRouteId: scopedId(value.accessRouteId, this.instanceId) }),
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

function definitionKey(definition: UsageIntegrationDefinition): string {
  return JSON.stringify({
    type: definition.type,
    credentialRef: definition.credentialRef,
    settings: definition.settings,
  });
}

export class ConfiguredUsageRuntime {
  readonly adapters = new UsageAdapterManager();
  readonly service: UsageService;
  private readonly active = new Map<string, ActiveIntegration>();

  constructor(
    store: UsageStore,
    private readonly catalog: UsageIntegrationCatalog,
    options: UsageServiceOptions = {},
  ) {
    this.service = new UsageService(store, this.adapters, options);
  }

  async applyConfig(config: UsageRuntimeConfig): Promise<void> {
    const configuredIds = new Set(config.integrations.map(({ id }) => id));
    if (configuredIds.size !== config.integrations.length) {
      throw new Error("Usage integration ids must be unique");
    }

    for (const [id] of this.active) {
      if (!configuredIds.has(id)) this.adapters.setEnabled(id, false);
    }

    for (const definition of config.integrations) {
      const existing = this.active.get(definition.id);
      if (!definition.enabled) {
        if (existing !== undefined) this.adapters.setEnabled(definition.id, false);
        continue;
      }

      const key = definitionKey(definition);
      if (existing === undefined || existing.definitionKey !== key) {
        const adapter = new InstanceScopedUsageAdapter(this.catalog.create(definition), definition.id);
        this.adapters.register(adapter, true, definition.id);
        this.active.set(definition.id, { definitionKey: key, adapter });
      } else {
        this.adapters.setEnabled(definition.id, true);
      }
    }
  }
}
