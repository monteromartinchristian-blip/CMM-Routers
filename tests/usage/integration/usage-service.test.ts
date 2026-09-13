import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CostEventBatch,
  QuotaSnapshotBatch,
  UsageAdapter,
  UsageAdapterCapability,
  UsageAdapterHealth,
  UsageAdapterManifest,
  UsageDiscoveryResult,
  UsageEventBatch,
  UsageRefreshResult,
} from "../../../src/usage/adapters/contract.js";
import { UsageAdapterError } from "../../../src/usage/adapters/contract.js";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { UsageRegistryService } from "../../../src/usage/registry/usage-registry.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

let store: SqliteUsageStore;
let nowMs: number;

class CollectionAdapter implements UsageAdapter {
  quotaCalls = 0;
  refreshCalls = 0;
  failQuota = false;

  constructor(
    readonly id: string,
    private readonly bucketId: string,
    private readonly minimumRefreshIntervalMs = 60_000,
    private readonly declaredCapabilities: readonly UsageAdapterCapability[] = [
      "collect_quota_snapshots",
      "manual_refresh",
    ],
  ) {}

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: this.id,
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: this.minimumRefreshIntervalMs,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set(this.declaredCapabilities);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy" };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    return { status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return { status: "ok", values: [] };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    this.quotaCalls += 1;
    if (this.failQuota) throw new UsageAdapterError("unavailable", "provider unavailable");
    return {
      status: "ok",
      values: [
        {
          id: `${this.id}:snapshot:${this.quotaCalls}`,
          quotaBucketId: this.bucketId,
          observedAt: new Date(nowMs).toISOString(),
          usedFraction: 0.9,
          remainingFraction: 0.1,
          resetAt: "2026-09-13T13:00:00.000Z",
          source: "provider_official_api",
          confidence: "exact",
          stalenessAfter: new Date(nowMs + 10 * 60_000).toISOString(),
        },
      ],
    };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return { status: "ok", values: [] };
  }

  async refresh(): Promise<UsageRefreshResult> {
    this.refreshCalls += 1;
    return { status: "ok", refreshedAt: new Date(nowMs).toISOString() };
  }
}

async function seedGraph(): Promise<{
  providerId: string;
  modelId: string;
  routeId: string;
  bucketId: string;
}> {
  const registry = new UsageRegistryService(store, {
    now: () => new Date(nowMs).toISOString(),
  });
  const provider = await registry.registerProvider({
    id: "provider:test",
    displayName: "Test Provider",
    kind: "first_party",
  });
  const account = await registry.registerAccount({
    id: "account:test",
    providerId: provider.id,
    label: "Test Account",
  });
  const product = await registry.registerProduct({
    id: "product:test",
    providerId: provider.id,
    displayName: "Test Product",
    kind: "subscription",
  });
  const model = await registry.registerModel({
    id: "model:test",
    canonicalName: "Test Model",
    vendor: "Test Vendor",
    lifecycle: "active",
  });
  const route = await registry.registerAccessRoute({
    id: "route:test",
    accountId: account.id,
    productId: product.id,
    modelIdentityId: model.id,
    providerModelId: "test-model",
    displayName: "Test Model",
    status: "available",
  });
  const bucket = await registry.registerQuotaBucket({
    id: "bucket:test",
    accountId: account.id,
    productId: product.id,
    displayName: "Test quota",
    metric: { kind: "percentage" },
    windowPolicy: { kind: "provider_reported" },
    unit: "fraction",
    enforcement: "hard",
    status: "healthy",
  });
  await registry.bindQuota({
    id: "binding:test",
    accessRouteId: route.id,
    quotaBucketId: bucket.id,
    activeFrom: "2026-09-01T00:00:00.000Z",
  });

  return { providerId: provider.id, modelId: model.id, routeId: route.id, bucketId: bucket.id };
}

function service(manager: UsageAdapterManager): UsageService {
  return new UsageService(store, manager, {
    scheduler: {
      now: () => nowMs,
      random: () => 0,
      jitterRatio: 0,
      baseBackoffMs: 1_000,
      maximumBackoffMs: 60_000,
      pumpIntervalMs: 60_000,
    },
  });
}

beforeEach(async () => {
  nowMs = Date.parse("2026-09-13T12:00:00.000Z");
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
});

afterEach(async () => {
  await store.close();
});

describe("UsageService orchestration", () => {
  it("runs only enabled adapters", async () => {
    const { bucketId } = await seedGraph();
    const enabled = new CollectionAdapter("enabled", bucketId);
    const disabled = new CollectionAdapter("disabled", bucketId);
    const manager = new UsageAdapterManager();
    manager.register(enabled);
    manager.register(disabled, false);
    const usage = service(manager);

    await usage.runCollectionCycle();

    expect(enabled.quotaCalls).toBe(1);
    expect(disabled.quotaCalls).toBe(0);
  });

  it("honors each adapter minimum refresh interval", async () => {
    const { bucketId } = await seedGraph();
    const adapter = new CollectionAdapter("interval", bucketId, 60_000);
    const manager = new UsageAdapterManager();
    manager.register(adapter);
    const usage = service(manager);

    await usage.runCollectionCycle();
    nowMs += 30_000;
    await usage.runCollectionCycle();
    nowMs += 31_000;
    await usage.runCollectionCycle();

    expect(adapter.quotaCalls).toBe(2);
  });

  it("backs off a failing adapter without blocking a healthy adapter", async () => {
    const { bucketId } = await seedGraph();
    const failing = new CollectionAdapter("failing", bucketId);
    failing.failQuota = true;
    const healthy = new CollectionAdapter("healthy", bucketId);
    const manager = new UsageAdapterManager();
    manager.register(failing);
    manager.register(healthy);
    const usage = service(manager);

    await usage.runCollectionCycle();
    expect(failing.quotaCalls).toBe(1);
    expect(healthy.quotaCalls).toBe(1);

    nowMs += 500;
    await usage.runCollectionCycle();
    expect(failing.quotaCalls).toBe(1);

    nowMs += 501;
    await usage.runCollectionCycle();
    expect(failing.quotaCalls).toBe(2);
    expect(healthy.quotaCalls).toBe(1);
  });

  it("manual refresh bypasses the ordinary refresh interval", async () => {
    const { bucketId } = await seedGraph();
    const adapter = new CollectionAdapter("manual", bucketId, 60_000);
    const manager = new UsageAdapterManager();
    manager.register(adapter);
    const usage = service(manager);

    await usage.runCollectionCycle();
    nowMs += 10_000;
    await usage.refresh(adapter.id);

    expect(adapter.refreshCalls).toBe(1);
    expect(adapter.quotaCalls).toBe(2);
  });

  it("starts and shuts down the scheduler cleanly", async () => {
    const manager = new UsageAdapterManager();
    const usage = service(manager);

    usage.start();
    expect(usage.isRunning()).toBe(true);
    await usage.stop();
    expect(usage.isRunning()).toBe(false);
  });

  it("serves route, model, provider and quota views from reconciled state", async () => {
    const ids = await seedGraph();
    const adapter = new CollectionAdapter("query", ids.bucketId);
    const manager = new UsageAdapterManager();
    manager.register(adapter);
    const usage = service(manager);

    await usage.runCollectionCycle();

    const route = await usage.queries.getRouteHealth(ids.routeId);
    const model = await usage.queries.getModelConstraints(ids.modelId);
    const provider = await usage.queries.getProviderPressure(ids.providerId);
    const quota = await usage.queries.getQuotaState(ids.bucketId);

    expect(route.status).toBe("critical");
    expect(route.primaryConstraint?.bucketId).toBe(ids.bucketId);
    expect(model.routes).toHaveLength(1);
    expect(model.routes[0]?.status).toBe("critical");
    expect(provider.status).toBe("critical");
    expect(provider.routes).toHaveLength(1);
    expect(quota.reconciled.selected?.remainingFraction).toBe(0.1);
    expect(quota.forecast.confidence).toBe("unknown");
  });
});
