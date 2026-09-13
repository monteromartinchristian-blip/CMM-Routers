import type {
  AccessRoute,
  Account,
  ConsumptionRule,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaGroup,
  QuotaSnapshot,
  SubscriptionPeriod,
} from "../../domain/types.js";
import { quotaSnapshotSchema } from "../../domain/validation.js";
import {
  unsupported,
  type CostEventBatch,
  type QuotaSnapshotBatch,
  type UsageAdapter,
  type UsageAdapterCapability,
  type UsageAdapterHealth,
  type UsageAdapterManifest,
  type UsageDiscoveryResult,
  type UsageEventBatch,
  type UsageRefreshResult,
} from "../contract.js";

export interface ManualUsageAdapterDefinition {
  id: string;
  displayName: string;
  provider: Provider;
  accounts: readonly Account[];
  products: readonly Product[];
  subscriptionPeriods?: readonly SubscriptionPeriod[];
  models?: readonly ModelIdentity[];
  accessRoutes: readonly AccessRoute[];
  quotaGroups?: readonly QuotaGroup[];
  quotaBuckets: readonly QuotaBucket[];
  quotaBindings: readonly QuotaBinding[];
  consumptionRules?: readonly ConsumptionRule[];
  quotaSnapshots: readonly QuotaSnapshot[];
}

const capabilities = new Set<UsageAdapterCapability>([
  "discover_accounts",
  "discover_products",
  "discover_models",
  "discover_quota_graph",
  "collect_quota_snapshots",
  "manual_refresh",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertReferences(definition: ManualUsageAdapterDefinition): void {
  const accountIds = new Set(definition.accounts.map((value) => value.id));
  const productIds = new Set(definition.products.map((value) => value.id));
  const subscriptionIds = new Set((definition.subscriptionPeriods ?? []).map((value) => value.id));
  const modelIds = new Set((definition.models ?? []).map((value) => value.id));
  const routeIds = new Set(definition.accessRoutes.map((value) => value.id));
  const bucketIds = new Set(definition.quotaBuckets.map((value) => value.id));
  const ruleIds = new Set((definition.consumptionRules ?? []).map((value) => value.id));

  for (const account of definition.accounts) {
    if (account.providerId !== definition.provider.id) {
      throw new Error(`Manual account ${account.id} references another provider`);
    }
  }
  for (const product of definition.products) {
    if (product.providerId !== definition.provider.id) {
      throw new Error(`Manual product ${product.id} references another provider`);
    }
  }
  for (const period of definition.subscriptionPeriods ?? []) {
    if (!accountIds.has(period.accountId) || !productIds.has(period.productId)) {
      throw new Error(`Manual subscription ${period.id} references an unknown account or product`);
    }
  }
  for (const route of definition.accessRoutes) {
    if (!accountIds.has(route.accountId) || !productIds.has(route.productId)) {
      throw new Error(`Manual route ${route.id} references an unknown account or product`);
    }
    if (route.subscriptionPeriodId !== undefined && !subscriptionIds.has(route.subscriptionPeriodId)) {
      throw new Error(`Manual route ${route.id} references an unknown subscription period`);
    }
    if (route.modelIdentityId !== undefined && !modelIds.has(route.modelIdentityId)) {
      throw new Error(`Manual route ${route.id} references an unknown model identity`);
    }
  }
  for (const bucket of definition.quotaBuckets) {
    if (!accountIds.has(bucket.accountId) || !productIds.has(bucket.productId)) {
      throw new Error(`Manual quota bucket ${bucket.id} references an unknown account or product`);
    }
  }
  for (const binding of definition.quotaBindings) {
    if (!routeIds.has(binding.accessRouteId) || !bucketIds.has(binding.quotaBucketId)) {
      throw new Error(`Manual quota binding ${binding.id} references an unknown route or bucket`);
    }
    if (binding.consumptionRuleId !== undefined && !ruleIds.has(binding.consumptionRuleId)) {
      throw new Error(`Manual quota binding ${binding.id} references an unknown consumption rule`);
    }
  }
  for (const snapshot of definition.quotaSnapshots) {
    if (!bucketIds.has(snapshot.quotaBucketId)) {
      throw new Error(`Manual quota snapshot ${snapshot.id} references an unknown bucket`);
    }
    const parsed = quotaSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new Error(`Invalid manual quota snapshot ${snapshot.id}`);
  }
}

export class ManualUsageAdapter implements UsageAdapter {
  readonly id: string;
  private readonly definition: ManualUsageAdapterDefinition;

  constructor(definition: ManualUsageAdapterDefinition) {
    assertReferences(definition);
    this.id = definition.id;
    this.definition = clone(definition);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: this.definition.displayName,
      collectionSafety: "non_inference_only",
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return capabilities;
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy", detail: "Manual usage data" };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    return {
      status: "ok",
      providers: [clone(this.definition.provider)],
      accounts: clone([...this.definition.accounts]),
      products: clone([...this.definition.products]),
      models: clone([...(this.definition.models ?? [])]),
      accessRoutes: clone([...this.definition.accessRoutes]),
      subscriptionPeriods: clone([...(this.definition.subscriptionPeriods ?? [])]),
      quotaGroups: clone([...(this.definition.quotaGroups ?? [])]),
      quotaBuckets: clone([...this.definition.quotaBuckets]),
      quotaBindings: clone([...this.definition.quotaBindings]),
      consumptionRules: clone([...(this.definition.consumptionRules ?? [])]),
      metadata: { mode: "manual" },
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    return { status: "ok", values: clone([...this.definition.quotaSnapshots]) };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return unsupported("collect_costs");
  }

  async refresh(): Promise<UsageRefreshResult> {
    return { status: "ok", refreshedAt: new Date().toISOString(), metadata: { mode: "manual" } };
  }
}
