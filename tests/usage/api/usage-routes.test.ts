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
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { UsageRegistryService } from "../../../src/usage/registry/usage-registry.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";

const bearerSecret = "chat-bearer-secret";
const usageToken = "usage-read-only-secret";
let store: SqliteUsageStore;
let nowMs: number;

class ApiAdapter implements UsageAdapter {
  readonly id = "api-test";
  refreshCalls = 0;
  quotaCalls = 0;

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "API Test",
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: 60_000,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set(["collect_quota_snapshots", "manual_refresh"]);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy" };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    return { status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return { status: "unsupported", capability: "collect_usage_events" };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    this.quotaCalls += 1;
    return {
      status: "ok",
      values: [{
        id: `snapshot:${this.quotaCalls}`,
        quotaBucketId: "bucket:api",
        observedAt: new Date(nowMs).toISOString(),
        usedFraction: 0.8,
        remainingFraction: 0.2,
        resetAt: "2026-09-13T13:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter: new Date(nowMs + 600_000).toISOString(),
      }],
    };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return { status: "unsupported", capability: "collect_costs" };
  }

  async refresh(): Promise<UsageRefreshResult> {
    this.refreshCalls += 1;
    return { status: "ok", refreshedAt: new Date(nowMs).toISOString() };
  }
}

async function setupUsage(): Promise<{ service: UsageService; adapter: ApiAdapter }> {
  const registry = new UsageRegistryService(store, { now: () => new Date(nowMs).toISOString() });
  const provider = await registry.registerProvider({
    id: "provider:api",
    displayName: "Example Provider",
    kind: "first_party",
  });
  const account = await registry.registerAccount({
    id: "account:api",
    providerId: provider.id,
    label: "Example Account",
  });
  const product = await registry.registerProduct({
    id: "product:api",
    providerId: provider.id,
    displayName: "Example Product",
    kind: "subscription",
  });
  const model = await registry.registerModel({
    id: "model:api",
    canonicalName: "Example Model",
    vendor: "Example Vendor",
    lifecycle: "active",
  });
  const route = await registry.registerAccessRoute({
    id: "route:api",
    accountId: account.id,
    productId: product.id,
    modelIdentityId: model.id,
    providerModelId: "example-model",
    displayName: "Example Model",
    status: "available",
  });
  const bucket = await registry.registerQuotaBucket({
    id: "bucket:api",
    accountId: account.id,
    productId: product.id,
    displayName: "Example quota",
    metric: { kind: "percentage" },
    windowPolicy: { kind: "provider_reported" },
    unit: "fraction",
    enforcement: "hard",
    status: "healthy",
  });
  await registry.bindQuota({
    id: "binding:api",
    accessRouteId: route.id,
    quotaBucketId: bucket.id,
    activeFrom: "2026-09-01T00:00:00.000Z",
  });
  await store.appendUsageEvents([{ id: "usage:api", occurredAt: "2026-09-13T11:59:00.000Z", providerId: provider.id, accountId: account.id, productId: product.id, accessRouteId: route.id, requests: 1, source: "router_measured", confidence: "measured", metadata: {} }]);
  await store.appendCostEvents([{ id: "cost:api", occurredAt: "2026-09-13T11:59:00.000Z", providerId: provider.id, accountId: account.id, productId: product.id, accessRouteId: route.id, amount: 0.01, currency: "USD", kind: "usage", source: "provider_official_api", confidence: "exact", metadata: {} }]);

  const adapter = new ApiAdapter();
  const adapters = new UsageAdapterManager();
  adapters.register(adapter);
  const service = new UsageService(store, adapters, {
    scheduler: { now: () => nowMs, jitterRatio: 0, random: () => 0 },
  });
  await service.runCollectionCycle();
  return { service, adapter };
}

function auth(token = usageToken): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  nowMs = Date.parse("2026-09-13T12:00:00.000Z");
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
});

afterEach(async () => {
  await store.close();
});

describe("CMM Usage local API", () => {
  it("allows the scoped usage credential on every read endpoint", async () => {
    const { service } = await setupUsage();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, usageToken, registry: new ProviderRegistry(), cmmUsageService: service });
    const paths = [
      "/v1/cmm/usage",
      "/v1/cmm/usage/providers",
      "/v1/cmm/usage/products",
      "/v1/cmm/usage/models",
      "/v1/cmm/usage/routes",
      "/v1/cmm/usage/quotas",
      "/v1/cmm/usage/history",
      "/v1/cmm/usage/costs",
      "/v1/cmm/usage/alerts",
    ];
    for (const path of paths) {
      const response = await server.inject({ method: "GET", url: path, headers: auth() });
      expect(response.statusCode, path).toBe(200);
    }
    await server.close();
  });

  it("does not allow the read-only usage credential to invoke inference", async () => {
    const { service } = await setupUsage();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, usageToken, registry: new ProviderRegistry(), cmmUsageService: service });
    const response = await server.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...auth(), "content-type": "application/json" }, payload: { model: "anything", messages: [{ role: "user", content: "hi" }] } });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it("exposes provenance and freshness without exposing bearer secrets", async () => {
    const { service } = await setupUsage();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, usageToken, registry: new ProviderRegistry(), cmmUsageService: service });
    const response = await server.inject({ method: "GET", url: "/v1/cmm/usage/quotas", headers: auth() });
    const body = response.json();
    const serialized = JSON.stringify(body);
    expect(response.statusCode).toBe(200);
    expect(body.data[0].reconciled.selected.source).toBe("provider_official_api");
    expect(body.data[0].reconciled.stale).toBe(false);
    expect(serialized).not.toContain(usageToken);
    expect(serialized).not.toContain(bearerSecret);
    await server.close();
  });

  it("manual refresh uses the usage adapter path", async () => {
    const { service, adapter } = await setupUsage();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, usageToken, registry: new ProviderRegistry(), cmmUsageService: service });
    const beforeQuotaCalls = adapter.quotaCalls;
    const response = await server.inject({ method: "POST", url: "/v1/cmm/usage/refresh", headers: { ...auth(), "content-type": "application/json" }, payload: { adapterId: adapter.id } });
    expect(response.statusCode).toBe(200);
    expect(adapter.refreshCalls).toBe(1);
    expect(adapter.quotaCalls).toBe(beforeQuotaCalls + 1);
    await server.close();
  });

  it("rejects a missing usage credential on the scoped usage API", async () => {
    const { service } = await setupUsage();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, usageToken, registry: new ProviderRegistry(), cmmUsageService: service });
    const response = await server.inject({ method: "GET", url: "/v1/cmm/usage/providers" });
    expect(response.statusCode).toBe(401);
    await server.close();
  });
});
