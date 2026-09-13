import { afterEach, describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { ManualUsageAdapter } from "../../../src/usage/adapters/manual/adapter.js";
import type {
  AccessRoute,
  Account,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  SubscriptionPeriod,
} from "../../../src/usage/domain/types.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

let store: SqliteUsageStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
});

const provider: Provider = {
  id: "provider:nebula",
  displayName: "Nebula AI",
  kind: "manual",
  status: "enabled",
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const account: Account = {
  id: "account:nebula:primary",
  providerId: provider.id,
  label: "Primary",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const product: Product = {
  id: "product:nebula:pro",
  providerId: provider.id,
  displayName: "Nebula Pro",
  kind: "subscription",
  metadata: {},
};

const subscriptions: SubscriptionPeriod[] = [
  {
    id: "subscription:nebula:old",
    accountId: account.id,
    productId: product.id,
    status: "cancelled",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-06-30T23:59:59.000Z",
    metadata: {},
  },
  {
    id: "subscription:nebula:current",
    accountId: account.id,
    productId: product.id,
    status: "active",
    startedAt: "2026-07-15T00:00:00.000Z",
    metadata: {},
  },
];

const models: ModelIdentity[] = [
  {
    id: "model:nebula:general",
    canonicalName: "Nebula General",
    vendor: "Nebula AI",
    lifecycle: "active",
    aliases: [],
    metadata: {},
  },
  {
    id: "model:nebula:reasoning",
    canonicalName: "Nebula Reasoning",
    vendor: "Nebula AI",
    lifecycle: "active",
    aliases: [],
    metadata: {},
  },
];

const routes: AccessRoute[] = [
  {
    id: "route:nebula:general",
    accountId: account.id,
    productId: product.id,
    subscriptionPeriodId: subscriptions[1]!.id,
    modelIdentityId: models[0]!.id,
    providerModelId: "nebula-general",
    displayName: "Nebula General",
    status: "available",
    metadata: {},
  },
  {
    id: "route:nebula:reasoning",
    accountId: account.id,
    productId: product.id,
    subscriptionPeriodId: subscriptions[1]!.id,
    modelIdentityId: models[1]!.id,
    providerModelId: "nebula-reasoning",
    displayName: "Nebula Reasoning",
    status: "available",
    metadata: {},
  },
];

const buckets: QuotaBucket[] = [
  {
    id: "bucket:nebula:shared-weekly",
    accountId: account.id,
    productId: product.id,
    displayName: "Shared weekly pool",
    metric: { kind: "percentage" },
    windowPolicy: {
      kind: "fixed_calendar",
      calendarUnit: "week",
      timezone: "Europe/Madrid",
      anchor: "monday",
    },
    unit: "fraction",
    enforcement: "hard",
    status: "healthy",
    metadata: {},
  },
  {
    id: "bucket:nebula:reasoning-window",
    accountId: account.id,
    productId: product.id,
    displayName: "Reasoning rolling window",
    metric: { kind: "requests" },
    windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
    limitValue: 250,
    unit: "requests",
    enforcement: "hard",
    status: "warning",
    metadata: {},
  },
];

const bindings: QuotaBinding[] = [
  {
    id: "binding:nebula:shared:general",
    accessRouteId: routes[0]!.id,
    quotaBucketId: buckets[0]!.id,
    activeFrom: "2026-07-15T00:00:00.000Z",
    metadata: {},
  },
  {
    id: "binding:nebula:shared:reasoning",
    accessRouteId: routes[1]!.id,
    quotaBucketId: buckets[0]!.id,
    activeFrom: "2026-07-15T00:00:00.000Z",
    metadata: {},
  },
  {
    id: "binding:nebula:reasoning-specific",
    accessRouteId: routes[1]!.id,
    quotaBucketId: buckets[1]!.id,
    activeFrom: "2026-07-15T00:00:00.000Z",
    metadata: {},
  },
];

const snapshots: QuotaSnapshot[] = [
  {
    id: "snapshot:nebula:shared",
    quotaBucketId: buckets[0]!.id,
    observedAt: "2026-09-13T12:00:00.000Z",
    usedFraction: 0.63,
    remainingFraction: 0.37,
    resetAt: "2026-09-14T07:00:00.000Z",
    source: "manual",
    confidence: "exact",
    stalenessAfter: "2026-09-14T07:00:00.000Z",
  },
  {
    id: "snapshot:nebula:reasoning",
    quotaBucketId: buckets[1]!.id,
    observedAt: "2026-09-13T12:00:00.000Z",
    usedValue: 190,
    remainingValue: 60,
    limitValue: 250,
    usedFraction: 0.76,
    remainingFraction: 0.24,
    resetAt: "2026-09-13T14:30:00.000Z",
    source: "manual",
    confidence: "exact",
    stalenessAfter: "2026-09-13T14:30:00.000Z",
  },
];

describe("ManualUsageAdapter", () => {
  it("ingests an arbitrary provider graph, shared/model quotas, reset policies and subscription history", async () => {
    store = new SqliteUsageStore(":memory:");
    await store.initialize();
    const manager = new UsageAdapterManager();
    const adapter = new ManualUsageAdapter({
      id: "manual:nebula",
      displayName: "Nebula manual integration",
      provider,
      accounts: [account],
      products: [product],
      subscriptionPeriods: subscriptions,
      models,
      accessRoutes: routes,
      quotaBuckets: buckets,
      quotaBindings: bindings,
      quotaSnapshots: snapshots,
    });
    manager.register(adapter);
    const service = new UsageService(store, manager, {
      scheduler: { now: () => Date.parse("2026-09-13T12:00:00.000Z"), jitterRatio: 0 },
    });

    const refreshed = await service.refresh(adapter.id);

    expect(refreshed).toMatchObject({ attempted: true, success: true });
    expect((await store.listProviders()).map((value) => value.id)).toEqual([provider.id]);
    expect((await store.listProducts(provider.id)).map((value) => value.id)).toEqual([product.id]);
    expect((await store.listSubscriptionPeriods(product.id)).map((value) => value.status).sort()).toEqual([
      "active",
      "cancelled",
    ]);

    const generalGraph = await store.getRouteGraph(routes[0]!.id);
    expect(generalGraph.bindings.map((value) => value.quotaBucketId)).toEqual([
      "bucket:nebula:shared-weekly",
    ]);

    const reasoningGraph = await store.getRouteGraph(routes[1]!.id);
    expect(reasoningGraph.bindings.map((value) => value.quotaBucketId).sort()).toEqual([
      "bucket:nebula:reasoning-window",
      "bucket:nebula:shared-weekly",
    ]);
    expect(reasoningGraph.quotaStates.map((value) => value.bucket.windowPolicy.kind).sort()).toEqual([
      "fixed_calendar",
      "rolling_duration",
    ]);

    const [percentage] = await store.getCurrentQuotaState(buckets[0]!.id);
    expect(percentage).toMatchObject({ usedFraction: 0.63, remainingFraction: 0.37 });
    expect(percentage).not.toHaveProperty("usedValue");
    expect(percentage).not.toHaveProperty("remainingValue");
    expect(percentage).not.toHaveProperty("limitValue");
  });

  it("rejects a manual snapshot that contradicts its own quota measurements", () => {
    expect(
      () =>
        new ManualUsageAdapter({
          id: "manual:invalid",
          displayName: "Invalid manual integration",
          provider,
          accounts: [account],
          products: [product],
          accessRoutes: [],
          quotaBuckets: [buckets[1]!],
          quotaBindings: [],
          quotaSnapshots: [
            {
              ...snapshots[1]!,
              usedValue: 200,
              remainingValue: 100,
              limitValue: 250,
            },
          ],
        }),
    ).toThrow(/snapshot|quota|invalid/i);
  });
});
