import type { UsageAdapterManager } from "../adapters/adapter-manager.js";
import type { UsageDiscoverySuccess } from "../adapters/contract.js";
import type {
  AccessRoute,
  CostEvent,
  OperationalIdentityRef,
  UsageEvent,
} from "../domain/types.js";
import { UsageEventIngestor } from "../ingestion/event-ingestor.js";
import { QuotaSnapshotIngestor } from "../ingestion/snapshot-ingestor.js";
import {
  CollectionScheduler,
  type CollectionRunResult,
  type CollectionSchedulerOptions,
} from "../scheduler/collection-scheduler.js";
import type { UsageStore } from "../storage/usage-store.js";
import { UsageQueryService } from "./usage-query-service.js";

export interface UsageServiceOptions {
  scheduler?: CollectionSchedulerOptions;
}

/**
 * Keeps only the observations a bound collector is allowed to reference.
 *
 * A collector bound to canonical Router identities may reference those
 * identities and nothing else. Anything outside the binding is dropped rather
 * than registered, so collection output can never introduce a new operational
 * provider, account, product or route.
 */
function withinBinding(
  binding: OperationalIdentityRef,
  value: {
    providerId: string;
    accountId: string;
    productId: string;
    accessRouteId?: string;
  },
): boolean {
  if (value.providerId !== binding.providerId) return false;
  if (binding.accountId === undefined || value.accountId !== binding.accountId) return false;
  if (binding.productId === undefined || value.productId !== binding.productId) return false;
  if (value.accessRouteId !== undefined && !binding.routeIds.includes(value.accessRouteId)) {
    return false;
  }
  return true;
}

function scopedDiscovery(
  result: UsageDiscoverySuccess,
  binding: OperationalIdentityRef,
): UsageDiscoverySuccess {
  const accessRoutes = result.accessRoutes.filter((route: AccessRoute) =>
    binding.routeIds.includes(route.id) &&
    route.accountId === binding.accountId &&
    route.productId === binding.productId);
  const modelIdentityIds = new Set(
    accessRoutes.flatMap((route) =>
      route.modelIdentityId === undefined ? [] : [route.modelIdentityId]),
  );
  const subscriptionPeriods = (result.subscriptionPeriods ?? []).filter(
    (value) => value.accountId === binding.accountId && value.productId === binding.productId,
  );
  const quotaGroups = (result.quotaGroups ?? []).filter(
    (value) => value.productId === binding.productId,
  );
  const quotaBuckets = (result.quotaBuckets ?? []).filter(
    (value) => value.accountId === binding.accountId && value.productId === binding.productId,
  );
  const quotaBindings = (result.quotaBindings ?? []).filter(
    (value) => accessRoutes.some((route) => route.id === value.accessRouteId),
  );

  return {
    ...result,
    providers: result.providers.filter((value) => value.id === binding.providerId),
    accounts: result.accounts.filter(
      (value) => value.id === binding.accountId && value.providerId === binding.providerId,
    ),
    products: result.products.filter(
      (value) => value.id === binding.productId && value.providerId === binding.providerId,
    ),
    models: result.models.filter((value) => modelIdentityIds.has(value.id)),
    accessRoutes,
    subscriptionPeriods,
    quotaGroups,
    quotaBuckets,
    quotaBindings,
  };
}

export class UsageService {
  readonly queries: UsageQueryService;
  private readonly events: UsageEventIngestor;
  private readonly snapshots: QuotaSnapshotIngestor;
  private readonly scheduler: CollectionScheduler;
  private readonly collectorBindings = new Map<string, OperationalIdentityRef>();

  constructor(
    private readonly store: UsageStore,
    private readonly adapters: UsageAdapterManager,
    options: UsageServiceOptions = {},
  ) {
    this.events = new UsageEventIngestor(store);
    this.snapshots = new QuotaSnapshotIngestor(store);
    const nowMs = options.scheduler?.now ?? Date.now;
    this.queries = new UsageQueryService(store, { now: () => new Date(nowMs()) });
    this.scheduler = new CollectionScheduler(
      adapters,
      async (adapterId) => this.collectAdapter(adapterId),
      options.scheduler,
    );
  }

  /**
   * Binds one collector to the canonical Router identities it may reference.
   *
   * Collection output is then restricted to those identities. This is the
   * Usage-side half of the authority boundary: a collector can observe a
   * Router-owned identity but can never register a new one.
   */
  bindCollector(adapterId: string, binding: OperationalIdentityRef): void {
    this.collectorBindings.set(adapterId, binding);
  }

  clearCollectorBinding(adapterId: string): void {
    this.collectorBindings.delete(adapterId);
  }

  collectorBinding(adapterId: string): OperationalIdentityRef | undefined {
    return this.collectorBindings.get(adapterId);
  }

  private async collectAdapter(adapterId: string): Promise<boolean> {
    const adapter = this.adapters.get(adapterId);
    if (adapter === undefined || !this.adapters.isEnabled(adapterId)) return false;
    const capabilities = adapter.capabilities();
    const binding = this.collectorBindings.get(adapterId);
    let success = true;

    const hasDiscovery =
      capabilities.has("discover_accounts") ||
      capabilities.has("discover_products") ||
      capabilities.has("discover_models") ||
      capabilities.has("discover_quota_graph");
    if (hasDiscovery) {
      const result = await this.adapters.discover(adapterId);
      if (result.status === "ok") {
        const discovery = binding === undefined ? result : scopedDiscovery(result, binding);
        for (const value of discovery.providers) await this.store.upsertProvider(value);
        for (const value of discovery.accounts) await this.store.upsertAccount(value);
        for (const value of discovery.products) await this.store.upsertProduct(value);
        for (const value of discovery.subscriptionPeriods ?? []) {
          await this.store.upsertSubscriptionPeriod(value);
        }
        for (const value of discovery.models) await this.store.upsertModelIdentity(value);
        for (const value of discovery.accessRoutes) await this.store.upsertAccessRoute(value);
        for (const value of discovery.quotaGroups ?? []) await this.store.upsertQuotaGroup(value);
        for (const value of discovery.quotaBuckets ?? []) await this.store.upsertQuotaBucket(value);
        for (const value of discovery.consumptionRules ?? []) {
          await this.store.upsertConsumptionRule(value);
        }
        for (const value of discovery.quotaBindings ?? []) {
          await this.store.upsertQuotaBinding(value);
        }
      } else if (result.status === "error") {
        success = false;
      }
    }

    if (capabilities.has("collect_usage_events")) {
      const result = await this.adapters.collectUsageEvents(adapterId);
      if (result.status === "ok") {
        const values = binding === undefined
          ? result.values
          : result.values.filter((value: UsageEvent) => withinBinding(binding, value));
        await this.events.ingest(values);
      } else if (result.status === "error") success = false;
    }

    if (capabilities.has("collect_quota_snapshots")) {
      const result = await this.adapters.collectQuotaSnapshots(adapterId);
      if (result.status === "ok") await this.snapshots.ingest(result.values);
      else if (result.status === "error") success = false;
    }

    if (capabilities.has("collect_costs")) {
      const result = await this.adapters.collectCostEvents(adapterId);
      if (result.status === "ok") {
        const values = binding === undefined
          ? result.values
          : result.values.filter((value: CostEvent) => withinBinding(binding, value));
        await this.store.appendCostEvents(values);
      } else if (result.status === "error") success = false;
    }

    return success;
  }

  async runCollectionCycle(): Promise<CollectionRunResult[]> {
    return this.scheduler.runDue();
  }

  async refresh(adapterId: string): Promise<CollectionRunResult> {
    const adapter = this.adapters.get(adapterId);
    if (adapter?.capabilities().has("manual_refresh")) {
      const refreshed = await this.adapters.refresh(adapterId);
      if (refreshed.status === "error") {
        return { adapterId, attempted: true, success: false };
      }
    }
    return this.scheduler.runNow(adapterId);
  }

  async refreshAll(): Promise<CollectionRunResult[]> {
    const results: CollectionRunResult[] = [];
    for (const { id, enabled } of this.adapters.list()) {
      if (!enabled) continue;
      results.push(await this.refresh(id));
    }
    return results;
  }

  start(): void {
    this.scheduler.start();
  }

  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
  }
}
