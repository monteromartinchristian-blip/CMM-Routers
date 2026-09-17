import { afterEach, describe, expect, it } from "vitest";
import type {
  AccessRouteSummary,
  AccountSummary,
  ModelIdentitySummary,
  ProductSummary,
  ProviderConnectionSummary,
  ProviderSummary,
  RouterCatalogProjection,
} from "../../../src/catalog/projection.js";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import {
  PresentationCatalogService,
  type RouterCatalogSource,
} from "../../../src/usage/presentation/presentation-catalog-service.js";
import { UsageQueryService } from "../../../src/usage/service/usage-query-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { seedCatalogScenario } from "../fixtures/catalog-scenarios.js";

const stores: SqliteUsageStore[] = [];

/**
 * Hand-authored Router truth for the catalog scenario. It is deliberately
 * written out rather than derived from Usage SQLite so a test can make the two
 * sources disagree and prove which one the presentation obeys.
 */
const routerProviders: readonly ProviderSummary[] = [
  { providerId: "command-code", displayName: "Command Code" },
  { providerId: "anthropic", displayName: "Anthropic" },
  { providerId: "google", displayName: "Google AI Pro" },
  { providerId: "openrouter", displayName: "OpenRouter" },
  { providerId: "kira", displayName: "Kira AI" },
];

const routerProducts: readonly ProductSummary[] = [
  { productId: "product:command-code:individual-goat", accountId: "account:command-code", providerId: "command-code", kind: "subscription", label: "individual-goat" },
  { productId: "product:anthropic", accountId: "account:anthropic", providerId: "anthropic", kind: "subscription", label: "Claude subscription" },
  { productId: "product:google", accountId: "account:google", providerId: "google", kind: "subscription", label: "Google AI Pro" },
  { productId: "product:openrouter", accountId: "account:openrouter", providerId: "openrouter", kind: "api", label: "OpenRouter credits" },
  { productId: "product:kira-promo", accountId: "account:kira", providerId: "kira", kind: "promo_pool", label: "Kira free access" },
];

const routerModels: readonly ModelIdentitySummary[] = [
  { modelIdentityId: "model:claude-sonnet", canonicalName: "Claude Sonnet", family: "Claude", aliases: ["claude-sonnet"] },
  { modelIdentityId: "model:qwen-flash", canonicalName: "Qwen Flash", family: "Qwen", aliases: ["qwen-flash"] },
  { modelIdentityId: "model:command-code", canonicalName: "Command Code", family: "Command", aliases: [] },
];

function routerProviderName(providerId: string): string {
  return routerProviders.find((provider) => provider.providerId === providerId)?.displayName
    ?? providerId;
}

const routerAccounts: readonly AccountSummary[] = routerProducts.map((product) => ({
  accountId: product.accountId,
  providerId: product.providerId,
  label: `${routerProviderName(product.providerId)} account`,
  identityStatus: "resolved",
}));

const routerConnections: readonly ProviderConnectionSummary[] = routerProducts.map((product) => ({
  connectionId: `connection:${product.providerId}`,
  providerId: product.providerId,
  accountId: product.accountId,
  productId: product.productId,
  connectionKind: "openai-chat-completions",
  status: "ready",
  identityStatus: "resolved",
}));

function routerRoute(
  routeId: string,
  providerId: string,
  modelIdentityId: string,
  providerModelId: string,
  overrides: Partial<Omit<AccessRouteSummary, "routeId" | "providerId" | "modelIdentityId" | "providerModelId">> = {},
): AccessRouteSummary {
  return {
    routeId,
    modelIdentityId,
    connectionId: `connection:${providerId}`,
    providerId,
    providerModelId,
    executionProfile: "default",
    capabilities: { chat: true, tools: true, streaming: true },
    billingClass: "subscription",
    routable: true,
    visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
    ...overrides,
  };
}

const routerRoutes: readonly AccessRouteSummary[] = [
  routerRoute("route:command-code", "command-code", "model:command-code", "command-code"),
  routerRoute("route:anthropic:claude", "anthropic", "model:claude-sonnet", "claude-sonnet"),
  routerRoute("route:google:claude", "google", "model:claude-sonnet", "claude-sonnet"),
  routerRoute("route:openrouter:claude", "openrouter", "model:claude-sonnet", "anthropic/claude-sonnet"),
  routerRoute("route:openrouter:qwen", "openrouter", "model:qwen-flash", "qwen/qwen-flash"),
  routerRoute("route:kira:qwen", "kira", "model:qwen-flash", "qwen-flash"),
];

function projection(
  routes: readonly AccessRouteSummary[] = routerRoutes,
): RouterCatalogProjection {
  return {
    providers: routerProviders,
    accounts: routerAccounts,
    products: routerProducts,
    connections: routerConnections,
    models: routerModels,
    routes,
  };
}

function routerSource(value: RouterCatalogProjection): RouterCatalogSource {
  return { read: () => value };
}

async function makeCatalog(
  options: {
    now?: string;
    projection?: RouterCatalogProjection;
  } = {},
) {
  const now = options.now ?? "2026-09-14T18:10:00.000Z";
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  await seedCatalogScenario(store);
  const queries = new UsageQueryService(store, { now: () => new Date(now) });
  const directory = createDefaultProviderDirectory();
  const catalog = new PresentationCatalogService(
    routerSource(options.projection ?? projection()),
    store,
    queries,
    directory,
    { now: () => new Date(now) },
  );
  return { store, queries, catalog };
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
    const { catalog } = await makeCatalog({ now: "2026-10-01T00:00:00.000Z" });
    const routes = await catalog.listRoutes();
    const promotions = await catalog.listPromotions();

    expect(routes.find((route) => route.routeId === "route:kira:qwen")?.offer.kind).toBe("UNKNOWN");
    expect(promotions.map((route) => route.routeId)).not.toContain("route:kira:qwen");
  });

  it("takes Router hidden and non-routable truth over disagreeing Usage preferences", async () => {
    const { store, catalog } = await makeCatalog({
      projection: projection(routerRoutes.map((route) =>
        route.routeId === "route:openrouter:claude"
          ? { ...route, routable: false, visibility: { visibleOn: ["admin_console" as const] } }
          : route)),
    });
    // Usage SQLite deliberately disagrees: the legacy preference store records
    // the route as visible while its Usage row records it as available.
    await store.upsertVisibilityPreference({
      scope: "global",
      routeId: "route:openrouter:claude",
      state: "visible",
    });

    const route = (await catalog.listRoutes())
      .find((entry) => entry.routeId === "route:openrouter:claude");

    expect(route?.visibility).toEqual({ visibleOn: ["admin_console"] });
    expect(route?.routable).toBe(false);
    // The Usage observation survives, but under a name that cannot be mistaken
    // for current Router availability.
    expect(route?.usageStatus).toBe("available");
    expect(route).not.toHaveProperty("availability");
    // Usage intelligence is still attached to the Router route.
    expect(route?.quota).toContainEqual(expect.objectContaining({
      bucketId: "bucket:openrouter:credits",
    }));
    expect(route?.provider).toEqual({ id: "openrouter", displayName: "OpenRouter" });
    expect(route?.model).toMatchObject({ id: "model:claude-sonnet", displayName: "Claude Sonnet" });
  });

  it("never recreates a current operational route from Usage-only history", async () => {
    const { catalog, queries, store } = await makeCatalog();
    await store.upsertAccessRoute({
      id: "route:openrouter:retired",
      accountId: "account:openrouter",
      productId: "product:openrouter",
      modelIdentityId: "model:claude-sonnet",
      providerModelId: "anthropic/retired-model",
      displayName: "Retired Sonnet",
      status: "available",
      metadata: {},
    });

    expect((await catalog.listRoutes()).map((route) => route.routeId))
      .not.toContain("route:openrouter:retired");
    expect(await catalog.getRoute("route:openrouter:retired")).toBeUndefined();
    // Historical Usage queries keep the observation queryable.
    expect((await queries.listRoutes()).map((view) => view.route.id))
      .toContain("route:openrouter:retired");
  });

  it("keeps a hidden route routable and its sibling routes visible", async () => {
    const { catalog } = await makeCatalog({
      projection: projection(routerRoutes.map((route) =>
        route.routeId === "route:openrouter:claude"
          ? { ...route, visibility: { visibleOn: ["admin_console" as const] } }
          : route)),
    });

    const routes = await catalog.listRoutes();
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")?.visibility)
      .toEqual({ visibleOn: ["admin_console"] });
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")?.routable).toBe(true);
    expect(routes.find((route) => route.routeId === "route:anthropic:claude")?.visibility)
      .toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    expect(routes.find((route) => route.routeId === "route:google:claude")?.visibility)
      .toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    expect((await catalog.listVisibleRoutes()).map((route) => route.routeId))
      .not.toContain("route:openrouter:claude");
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
    const queries = new UsageQueryService(store);
    // Static metadata only: Usage integration definitions no longer feed
    // connection state or instance handles.
    const directory = createDefaultProviderDirectory();
    const catalog = new PresentationCatalogService(
      routerSource(projection()),
      store,
      queries,
      directory,
    );

    const provider = (await catalog.listProviders()).find(
      (entry) => entry.directory.integrationType === "openrouter",
    );
    // Connection state and instance handles now come from the Router
    // projection, never from Usage integration definitions.
    expect(provider).toMatchObject({
      directory: { state: "connected", connectedInstanceCount: 1 },
      instanceIds: ["connection:openrouter"],
    });
    expect(JSON.stringify(provider)).not.toContain("credentialRef");
    expect(JSON.stringify(provider)).not.toContain("secretish");
  });

  it("keeps historical usage for a canonical route after Router removes it", async () => {
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    await store.initialize();
    await seedCatalogScenario(store);

    const routeId = "route:openrouter:claude";
    // The canonical route row Usage keys its observations on.
    await store.upsertAccessRoute({
      id: routeId,
      accountId: "account:openrouter",
      productId: "product:openrouter",
      providerModelId: "anthropic/claude-sonnet",
      displayName: "Claude Sonnet",
      status: "available",
      metadata: {},
    });
    await store.appendUsageEvents([
      {
        id: "usage:history:1",
        occurredAt: "2026-09-14T17:30:00.000Z",
        providerId: "provider:openrouter",
        accountId: "account:openrouter",
        productId: "product:openrouter",
        accessRouteId: routeId,
        modelIdentityId: "model:claude-sonnet",
        requests: 4,
        source: "router_measured",
        confidence: "measured",
        metadata: {},
      },
    ]);
    await store.appendCostEvents([
      {
        id: "cost:history:1",
        occurredAt: "2026-09-14T17:30:00.000Z",
        providerId: "provider:openrouter",
        accountId: "account:openrouter",
        productId: "product:openrouter",
        accessRouteId: routeId,
        amount: 0.42,
        currency: "USD",
        kind: "usage",
        source: "provider_official_api",
        confidence: "exact",
        metadata: {},
      },
    ]);
    await store.appendQuotaSnapshots([
      {
        id: "snapshot:history:1",
        quotaBucketId: "bucket:openrouter:credits",
        observedAt: "2026-09-14T18:00:00.000Z",
        remainingValue: 7.31,
        stalenessAfter: "2026-09-14T19:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
      },
    ]);

    // A mutable Router source so the route can be removed/disconnected.
    let current = projection();
    const queries = new UsageQueryService(store, {
      now: () => new Date("2026-09-14T18:10:00.000Z"),
    });
    const catalog = new PresentationCatalogService(
      { read: () => current },
      store,
      queries,
      createDefaultProviderDirectory(),
      { now: () => new Date("2026-09-14T18:10:00.000Z") },
    );

    // 1. While Router still has it, the route is current and history is readable.
    const before = await catalog.getRouteHistory(routeId);
    expect(before.currentOperationalRoute).toBe(true);
    expect(before.usageEvents).toHaveLength(1);
    expect(before.costEvents).toHaveLength(1);
    // The bucket already carries a seeded snapshot; ours is alongside it.
    expect(before.quotaSnapshots.some((snapshot) => snapshot.id === "snapshot:history:1"))
      .toBe(true);

    // 2. Router removes the route (disconnect/removal).
    current = projection(current.routes.filter((route) => route.routeId !== routeId));

    // 3. The current operational list no longer presents it as executable.
    expect((await catalog.listRoutes()).some((route) => route.routeId === routeId)).toBe(false);

    // 4. Historical Usage still returns every observation, explicitly non-current.
    const after = await catalog.getRouteHistory(routeId);
    expect(after.routeId).toBe(routeId);
    expect(after.currentOperationalRoute).toBe(false);
    expect(after.usageEvents).toHaveLength(1);
    expect(after.costEvents).toHaveLength(1);
    expect(after.quotaSnapshots.some((snapshot) => snapshot.id === "snapshot:history:1"))
      .toBe(true);
    expect(after.usageEvents[0]?.id).toBe("usage:history:1");
    expect(after.costEvents[0]?.amount).toBe(0.42);

    // 5. Disconnect deleted no rows: the Usage route row and its history survive.
    expect(await store.getAccessRoute(routeId)).toBeDefined();
    expect((await store.listUsageEvents(50)).some((event) => event.id === "usage:history:1"))
      .toBe(true);
  });
});
