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
import {
  ConfiguredUsageRuntime,
  UsageIntegrationCatalog,
  type UsageIntegrationDefinition,
} from "../../../src/usage/runtime/configured-runtime.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

let store: SqliteUsageStore;
let nowMs: number;

class FixedGraphAdapter implements UsageAdapter {
  readonly id = "fixed-graph";
  collections = 0;
  fail = false;

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "Fixed graph",
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: 1_000,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set(["discover_quota_graph", "collect_quota_snapshots", "manual_refresh"]);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: this.fail ? "unavailable" : "healthy" };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    if (this.fail) throw new Error("provider unavailable");
    return {
      status: "ok",
      providers: [{
        id: "provider:fixed",
        displayName: "Fixed Provider",
        kind: "first_party",
        status: "enabled",
        metadata: {},
        createdAt: "2026-09-13T12:00:00.000Z",
        updatedAt: "2026-09-13T12:00:00.000Z",
      }],
      accounts: [{
        id: "account:fixed",
        providerId: "provider:fixed",
        label: "Fixed Account",
        status: "active",
        createdAt: "2026-09-13T12:00:00.000Z",
        updatedAt: "2026-09-13T12:00:00.000Z",
      }],
      products: [{
        id: "product:fixed",
        providerId: "provider:fixed",
        displayName: "Fixed Product",
        kind: "subscription",
        metadata: {},
      }],
      models: [{
        id: "model:fixed",
        canonicalName: "Fixed Model",
        vendor: "Fixed",
        lifecycle: "active",
        aliases: [],
        metadata: {},
      }],
      accessRoutes: [{
        id: "route:fixed",
        accountId: "account:fixed",
        productId: "product:fixed",
        modelIdentityId: "model:fixed",
        providerModelId: "fixed-model",
        displayName: "Fixed Model",
        status: "available",
        metadata: {},
      }],
      quotaBuckets: [{
        id: "bucket:fixed",
        accountId: "account:fixed",
        productId: "product:fixed",
        displayName: "Fixed quota",
        metric: { kind: "percentage" },
        windowPolicy: { kind: "provider_reported" },
        unit: "fraction",
        enforcement: "hard",
        status: "healthy",
        metadata: {},
      }],
      quotaBindings: [{
        id: "binding:fixed",
        accessRouteId: "route:fixed",
        quotaBucketId: "bucket:fixed",
        activeFrom: "2026-09-13T00:00:00.000Z",
        metadata: {},
      }],
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return { status: "unsupported", capability: "collect_usage_events" };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    this.collections += 1;
    if (this.fail) throw new Error("provider unavailable");
    return {
      status: "ok",
      values: [{
        id: `snapshot:fixed:${this.collections}`,
        quotaBucketId: "bucket:fixed",
        observedAt: new Date(nowMs).toISOString(),
        usedFraction: 0.8,
        remainingFraction: 0.2,
        resetAt: "2026-09-13T13:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter: new Date(nowMs + 60_000).toISOString(),
      }],
    };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return { status: "unsupported", capability: "collect_costs" };
  }

  async refresh(): Promise<UsageRefreshResult> {
    return { status: "ok", refreshedAt: new Date(nowMs).toISOString() };
  }
}

function integration(id: string, enabled = true): UsageIntegrationDefinition {
  return {
    id,
    type: "fixed",
    enabled,
    credentialRef: "keychain://cmm-usage/test",
    settings: {},
  };
}

beforeEach(async () => {
  nowMs = Date.parse("2026-09-13T12:00:00.000Z");
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
});

afterEach(async () => {
  await store.close();
});

describe("ConfiguredUsageRuntime", () => {
  it("instantiates only enabled integrations and makes their normalized graph queryable", async () => {
    const created: string[] = [];
    const catalog = new UsageIntegrationCatalog();
    catalog.register("fixed", (definition) => {
      created.push(definition.id);
      return new FixedGraphAdapter();
    });
    const runtime = new ConfiguredUsageRuntime(store, catalog, {
      scheduler: { now: () => nowMs, jitterRatio: 0, random: () => 0 },
    });

    await runtime.applyConfig({ integrations: [integration("primary"), integration("disabled", false)] });
    await runtime.service.runCollectionCycle();

    expect(created).toEqual(["primary"]);
    expect(runtime.adapters.list().map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: "primary", enabled: true },
    ]);
    expect((await runtime.service.queries.listProviders()).map(({ provider }) => provider.id)).toEqual([
      "provider:fixed",
    ]);
    const [quota] = await runtime.service.queries.listQuotas();
    expect(quota?.reconciled.selected).toMatchObject({
      remainingFraction: 0.2,
      resetAt: "2026-09-13T13:00:00.000Z",
      source: "provider_official_api",
      confidence: "exact",
    });
  });

  it("keeps same-type instances isolated while sharing canonical provider/product/model identity", async () => {
    const catalog = new UsageIntegrationCatalog();
    catalog.register("fixed", () => new FixedGraphAdapter());
    const runtime = new ConfiguredUsageRuntime(store, catalog, {
      scheduler: { now: () => nowMs, jitterRatio: 0, random: () => 0 },
    });

    await runtime.applyConfig({ integrations: [integration("personal"), integration("work")] });
    await runtime.service.runCollectionCycle();

    expect(await store.listProviders()).toHaveLength(1);
    expect(await store.listProducts()).toHaveLength(1);
    expect(await store.listModelIdentities()).toHaveLength(1);
    const routes = await store.listAccessRoutes();
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((route) => route.accountId)).size).toBe(2);
    expect(new Set(routes.map((route) => route.productId))).toEqual(new Set(["product:fixed"]));
    expect(new Set(routes.map((route) => route.modelIdentityId))).toEqual(new Set(["model:fixed"]));
  });

  it("disables collection without deleting history and re-enables the same canonical instance identity", async () => {
    let adapter: FixedGraphAdapter | undefined;
    const catalog = new UsageIntegrationCatalog();
    catalog.register("fixed", () => (adapter = new FixedGraphAdapter()));
    const runtime = new ConfiguredUsageRuntime(store, catalog, {
      scheduler: { now: () => nowMs, jitterRatio: 0, random: () => 0 },
    });

    await runtime.applyConfig({ integrations: [integration("primary")] });
    await runtime.service.runCollectionCycle();
    const [routeBefore] = await store.listAccessRoutes();
    const [bucketBefore] = await store.listQuotaBuckets();
    expect(adapter?.collections).toBe(1);
    expect(await store.getCurrentQuotaState(bucketBefore!.id)).toHaveLength(1);

    await runtime.applyConfig({ integrations: [integration("primary", false)] });
    nowMs += 2_000;
    await runtime.service.runCollectionCycle();
    expect(adapter?.collections).toBe(1);
    expect(await store.getCurrentQuotaState(bucketBefore!.id)).toHaveLength(1);

    await runtime.applyConfig({ integrations: [integration("primary")] });
    await runtime.service.refresh("primary");
    const [routeAfter] = await store.listAccessRoutes();
    expect(adapter?.collections).toBe(2);
    expect(routeAfter?.id).toBe(routeBefore?.id);
    expect(routeAfter?.accountId).toBe(routeBefore?.accountId);
  });

  it("isolates one integration failure from healthy configured integrations", async () => {
    const adapters = new Map<string, FixedGraphAdapter>();
    const catalog = new UsageIntegrationCatalog();
    catalog.register("fixed", (definition) => {
      const adapter = new FixedGraphAdapter();
      adapter.fail = definition.id === "broken";
      adapters.set(definition.id, adapter);
      return adapter;
    });
    const runtime = new ConfiguredUsageRuntime(store, catalog, {
      scheduler: { now: () => nowMs, jitterRatio: 0, random: () => 0 },
    });

    await runtime.applyConfig({ integrations: [integration("broken"), integration("healthy")] });
    const results = await runtime.service.runCollectionCycle();

    expect(results.find(({ adapterId }) => adapterId === "broken")?.success).toBe(false);
    expect(results.find(({ adapterId }) => adapterId === "healthy")?.success).toBe(true);
    expect(adapters.get("healthy")?.collections).toBe(1);
  });
});
