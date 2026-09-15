import { afterEach, describe, expect, it } from "vitest";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import { PresentationCatalogService } from "../../../src/usage/presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { UsageQueryService } from "../../../src/usage/service/usage-query-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { seedCatalogScenario } from "../fixtures/catalog-scenarios.js";

const stores: SqliteUsageStore[] = [];

async function makeCatalog(now = "2026-09-14T18:10:00.000Z") {
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  await seedCatalogScenario(store);
  const visibility = new VisibilityStore(store);
  const queries = new UsageQueryService(store, { now: () => new Date(now) });
  const directory = createDefaultProviderDirectory([]);
  return { store, visibility, catalog: new PresentationCatalogService(store, queries, directory, visibility, { now: () => new Date(now) }) };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("PresentationCatalogService", () => {
  it("preserves heterogeneous provider-native metrics without a universal conversion", async () => {
    const { catalog } = await makeCatalog();
    const quotas = await catalog.listQuotaSummaries();

    expect(quotas.map((quota) => quota.metric.kind)).toEqual(expect.arrayContaining([
      "percentage",
      "credits",
      "tokens",
      "requests",
      "currency",
      "provider_defined",
    ]));
    const percentageOnly = quotas.find((quota) => quota.bucketId === "bucket:anthropic:weekly");
    expect(percentageOnly).toMatchObject({
      usedFraction: 0.61,
      remainingFraction: 0.39,
      windowPolicy: { kind: "provider_reported" },
    });
    expect(percentageOnly?.limit).toBeUndefined();
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:five-hour")?.windowPolicy)
      .toMatchObject({ kind: "rolling_duration", durationSeconds: 18_000 });
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:free")?.windowPolicy)
      .toEqual({ kind: "none" });
  });

  it("represents one shared pool once with all affected routes", async () => {
    const { catalog } = await makeCatalog();
    const shared = (await catalog.listQuotaSummaries())
      .filter((quota) => quota.bucketId === "bucket:openrouter:credits");

    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      scope: { kind: "shared_pool", productId: "product:openrouter" },
      remaining: 7.31,
    });
    expect(shared[0]?.affectedRouteIds).toEqual([
      "route:openrouter:claude",
      "route:openrouter:qwen",
    ]);
  });

  it("keeps supplemental Command Code balances observable but non-constraining", async () => {
    const { catalog } = await makeCatalog();
    const quotas = await catalog.listQuotaSummaries();
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:free")).toMatchObject({
      remaining: 0,
      constraining: false,
    });
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:purchased")).toMatchObject({
      remaining: 0,
      constraining: false,
    });
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:monthly")?.constraining).toBe(true);
  });

  it("projects evidence-based offers and friendly product labels", async () => {
    const { catalog } = await makeCatalog();
    const routes = await catalog.listRoutes();

    expect(routes.find((route) => route.routeId === "route:command-code")).toMatchObject({
      product: { displayName: "GOAT" },
      offer: { kind: "INCLUDED" },
    });
    expect(routes.find((route) => route.routeId === "route:kira:qwen")).toMatchObject({
      offer: { kind: "PROMO", validUntil: "2026-09-30T23:59:59.000Z" },
    });
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")).toMatchObject({
      offer: { kind: "PAYG" },
    });
  });

  it("stops advertising expired promotional access", async () => {
    const { catalog } = await makeCatalog("2026-10-01T00:00:00.000Z");
    const routes = await catalog.listRoutes();
    const promotions = await catalog.listPromotions();

    expect(routes.find((route) => route.routeId === "route:kira:qwen")?.offer.kind).toBe("UNKNOWN");
    expect(promotions.map((route) => route.routeId)).not.toContain("route:kira:qwen");
  });

  it("hides only the selected provider route and leaves sibling routes visible", async () => {
    const { catalog, visibility } = await makeCatalog();
    await visibility.set({ scope: "global", routeId: "route:openrouter:claude", state: "hidden" });

    const routes = await catalog.listRoutes();
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")?.visibility).toBe("hidden");
    expect(routes.find((route) => route.routeId === "route:anthropic:claude")?.visibility).toBe("visible");
    expect(routes.find((route) => route.routeId === "route:google:claude")?.visibility).toBe("visible");
    expect((await catalog.listVisibleRoutes()).map((route) => route.routeId)).not.toContain("route:openrouter:claude");
  });

  it("keeps supported disconnected providers in the product catalog", async () => {
    const { catalog } = await makeCatalog();
    expect((await catalog.listProviders()).find((provider) => provider.directory.integrationType === "chatgpt-subscription")).toMatchObject({
      directory: { state: "available", connectedInstanceCount: 0 },
    });
  });

  it("returns opaque connected instance handles without provider secrets", async () => {
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    await store.initialize();
    const visibility = new VisibilityStore(store);
    const queries = new UsageQueryService(store);
    const directory = createDefaultProviderDirectory([
      {
        id: "openrouter-primary",
        type: "openrouter",
        enabled: true,
        credentialRef: "keychain://CMM%20Usage/openrouter-primary",
        settings: { internal: "secretish" },
      },
    ]);
    const catalog = new PresentationCatalogService(store, queries, directory, visibility);

    const provider = (await catalog.listProviders()).find(
      (entry) => entry.directory.integrationType === "openrouter",
    );
    expect(provider).toMatchObject({
      directory: { state: "connected", connectedInstanceCount: 1 },
      instanceIds: ["openrouter-primary"],
    });
    expect(JSON.stringify(provider)).not.toContain("credentialRef");
    expect(JSON.stringify(provider)).not.toContain("secretish");
  });
});
