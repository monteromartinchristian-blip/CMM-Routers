import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageRegistryService } from "../../../src/usage/registry/usage-registry.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

let store: SqliteUsageStore;
let registry: UsageRegistryService;

beforeEach(async () => {
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
  registry = new UsageRegistryService(store, {
    now: () => "2026-09-13T12:00:00.000Z",
    id: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}:test-${++sequence}`;
    })(),
  });
});

afterEach(async () => {
  await store.close();
});

async function seedProviderProduct(): Promise<{ providerId: string; productId: string }> {
  const provider = await registry.registerProvider({
    displayName: "Example Provider",
    kind: "first_party",
  });
  const product = await registry.registerProduct({
    providerId: provider.id,
    displayName: "Example Pro",
    kind: "subscription",
  });
  return { providerId: provider.id, productId: product.id };
}

describe("UsageRegistryService", () => {
  it("allows multiple accounts for one provider without conflating them", async () => {
    const provider = await registry.registerProvider({
      displayName: "Example Provider",
      kind: "first_party",
    });

    const first = await registry.registerAccount({ providerId: provider.id, label: "Personal" });
    const second = await registry.registerAccount({ providerId: provider.id, label: "Work" });

    expect(first.providerId).toBe(provider.id);
    expect(second.providerId).toBe(provider.id);
    expect(first.id).not.toBe(second.id);
  });

  it("disables and re-enables a provider without deleting subscription history", async () => {
    const { providerId, productId } = await seedProviderProduct();
    const account = await registry.registerAccount({ providerId, label: "Personal" });
    const subscription = await registry.startSubscription({ accountId: account.id, productId });

    const disabled = await registry.setProviderEnabled(providerId, false);
    expect(disabled.status).toBe("disabled");
    expect(await store.getSubscriptionPeriod(subscription.id)).toEqual(subscription);

    const enabled = await registry.setProviderEnabled(providerId, true);
    expect(enabled.status).toBe("enabled");
    expect(await store.getSubscriptionPeriod(subscription.id)).toEqual(subscription);
  });

  it("closes a cancelled subscription period and re-subscribes with a new period", async () => {
    const { providerId, productId } = await seedProviderProduct();
    const account = await registry.registerAccount({ providerId, label: "Personal" });
    const first = await registry.startSubscription({ accountId: account.id, productId });

    const cancelled = await registry.endSubscription({
      subscriptionPeriodId: first.id,
      status: "cancelled",
    });
    const second = await registry.startSubscription({ accountId: account.id, productId });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.endedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
    expect(await store.listSubscriptionPeriods(productId)).toHaveLength(2);
  });

  it("keeps one conceptual model independent across multiple products and routes", async () => {
    const firstProvider = await registry.registerProvider({
      displayName: "Provider A",
      kind: "first_party",
    });
    const secondProvider = await registry.registerProvider({
      displayName: "Provider B",
      kind: "aggregator",
    });
    const firstProduct = await registry.registerProduct({
      providerId: firstProvider.id,
      displayName: "Direct Plan",
      kind: "subscription",
    });
    const secondProduct = await registry.registerProduct({
      providerId: secondProvider.id,
      displayName: "Aggregator Plan",
      kind: "subscription",
    });
    const firstAccount = await registry.registerAccount({
      providerId: firstProvider.id,
      label: "Direct",
    });
    const secondAccount = await registry.registerAccount({
      providerId: secondProvider.id,
      label: "Aggregator",
    });
    const model = await registry.registerModel({
      canonicalName: "Example Model",
      vendor: "Example Labs",
      lifecycle: "active",
      aliases: ["example-model"],
    });

    const direct = await registry.registerAccessRoute({
      accountId: firstAccount.id,
      productId: firstProduct.id,
      modelIdentityId: model.id,
      providerModelId: "example-model",
      displayName: "Example Model Direct",
    });
    const aggregate = await registry.registerAccessRoute({
      accountId: secondAccount.id,
      productId: secondProduct.id,
      modelIdentityId: model.id,
      providerModelId: "vendor/example-model",
      displayName: "Example Model Aggregated",
    });

    expect(direct.modelIdentityId).toBe(model.id);
    expect(aggregate.modelIdentityId).toBe(model.id);
    expect(direct.id).not.toBe(aggregate.id);
  });

  it("registers an unresolved provider route before canonical model resolution", async () => {
    const { providerId, productId } = await seedProviderProduct();
    const account = await registry.registerAccount({ providerId, label: "Personal" });

    const route = await registry.registerAccessRoute({
      accountId: account.id,
      productId,
      providerModelId: "new-model-preview-2026",
      displayName: "New Model Preview",
    });

    expect(route.modelIdentityId).toBeUndefined();
    expect((await store.getAccessRoute(route.id))?.providerModelId).toBe("new-model-preview-2026");
  });

  it("binds one quota bucket to multiple access routes without copying the bucket", async () => {
    const { providerId, productId } = await seedProviderProduct();
    const account = await registry.registerAccount({ providerId, label: "Personal" });
    const firstRoute = await registry.registerAccessRoute({
      accountId: account.id,
      productId,
      providerModelId: "model-a",
      displayName: "Model A",
    });
    const secondRoute = await registry.registerAccessRoute({
      accountId: account.id,
      productId,
      providerModelId: "model-b",
      displayName: "Model B",
    });
    const bucket = await registry.registerQuotaBucket({
      accountId: account.id,
      productId,
      displayName: "Shared weekly pool",
      metric: { kind: "requests" },
      windowPolicy: {
        kind: "fixed_calendar",
        calendarUnit: "week",
        timezone: "Europe/Madrid",
      },
      unit: "requests",
      enforcement: "hard",
      status: "healthy",
    });

    const firstBinding = await registry.bindQuota({
      accessRouteId: firstRoute.id,
      quotaBucketId: bucket.id,
    });
    const secondBinding = await registry.bindQuota({
      accessRouteId: secondRoute.id,
      quotaBucketId: bucket.id,
    });

    expect(firstBinding.quotaBucketId).toBe(bucket.id);
    expect(secondBinding.quotaBucketId).toBe(bucket.id);
    expect((await store.getRouteGraph(firstRoute.id)).quotaStates[0]?.bucket.id).toBe(bucket.id);
    expect((await store.getRouteGraph(secondRoute.id)).quotaStates[0]?.bucket.id).toBe(bucket.id);
  });
});
