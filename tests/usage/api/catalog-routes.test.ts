import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AccessRouteSummary,
  AccountSummary,
  ProviderConnectionSummary,
  RouterCatalogProjection,
} from "../../../src/catalog/projection.js";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import {
  PresentationCatalogService,
  type RouterCatalogSource,
} from "../../../src/usage/presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { seedCatalogScenario } from "../fixtures/catalog-scenarios.js";

const bearerSecret = "chat-bearer";
const usageToken = "catalog-read-token";
let store: SqliteUsageStore;

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

/**
 * Router truth for the API fixture. `route:openrouter:claude` is hidden from
 * every consumer surface but stays routable, so the payload proves hiding is
 * not disconnection and not a routability change.
 */
function routerProjection(): RouterCatalogProjection {
  const providers = [
    { providerId: "provider:command-code", displayName: "Command Code" },
    { providerId: "provider:anthropic", displayName: "Anthropic" },
    { providerId: "provider:google", displayName: "Google AI Pro" },
    { providerId: "provider:openrouter", displayName: "OpenRouter" },
    { providerId: "provider:kira", displayName: "Kira AI" },
  ];
  const products = [
    { productId: "product:command-code:individual-goat", accountId: "account:command-code", providerId: "provider:command-code", kind: "subscription" as const, label: "individual-goat" },
    { productId: "product:anthropic", accountId: "account:anthropic", providerId: "provider:anthropic", kind: "subscription" as const, label: "Claude subscription" },
    { productId: "product:google", accountId: "account:google", providerId: "provider:google", kind: "subscription" as const, label: "Google AI Pro" },
    { productId: "product:openrouter", accountId: "account:openrouter", providerId: "provider:openrouter", kind: "api" as const, label: "OpenRouter credits" },
    { productId: "product:kira-promo", accountId: "account:kira", providerId: "provider:kira", kind: "promo_pool" as const, label: "Kira free access" },
  ];
  const accounts: readonly AccountSummary[] = products.map((product) => ({
    accountId: product.accountId,
    providerId: product.providerId,
    label: `${providers.find((entry) => entry.providerId === product.providerId)?.displayName ?? product.providerId} account`,
    identityStatus: "resolved",
  }));
  const connections: readonly ProviderConnectionSummary[] = products.map((product) => ({
    connectionId: `connection:${product.providerId}`,
    providerId: product.providerId,
    accountId: product.accountId,
    productId: product.productId,
    connectionKind: "openai-chat-completions",
    status: "ready",
    identityStatus: "resolved",
  }));
  return {
    providers,
    accounts,
    products,
    connections,
    models: [
      { modelIdentityId: "model:claude-sonnet", canonicalName: "Claude Sonnet", family: "Claude", aliases: [] },
      { modelIdentityId: "model:qwen-flash", canonicalName: "Qwen Flash", family: "Qwen", aliases: [] },
      { modelIdentityId: "model:command-code", canonicalName: "Command Code", family: "Command", aliases: [] },
    ],
    routes: [
      routerRoute("route:command-code", "provider:command-code", "model:command-code", "command-code"),
      routerRoute("route:anthropic:claude", "provider:anthropic", "model:claude-sonnet", "claude-sonnet"),
      routerRoute("route:google:claude", "provider:google", "model:claude-sonnet", "claude-sonnet"),
      routerRoute("route:openrouter:claude", "provider:openrouter", "model:claude-sonnet", "anthropic/claude-sonnet", {
        visibility: { visibleOn: ["admin_console"] },
      }),
      routerRoute("route:openrouter:qwen", "provider:openrouter", "model:qwen-flash", "qwen/qwen-flash"),
      routerRoute("route:kira:qwen", "provider:kira", "model:qwen-flash", "qwen-flash"),
    ],
  };
}

async function fixture() {
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
  await seedCatalogScenario(store);
  const service = new UsageService(store, new UsageAdapterManager(), {
    scheduler: { now: () => Date.parse("2026-09-14T18:10:00.000Z") },
  });
  // The legacy preference store deliberately disagrees with Router: it records
  // the admin-only route as visible.
  const visibility = new VisibilityStore(store);
  await store.upsertVisibilityPreference({
    scope: "global",
    routeId: "route:openrouter:claude",
    state: "visible",
  });
  const directory = createDefaultProviderDirectory([
    {
      id: "command-code-live",
      type: "command-code",
      enabled: true,
      credentialRef: "keychain://CMM%20Usage/private-test-ref",
      settings: { baseUrl: "https://api.commandcode.ai" },
    },
  ]);
  const routerCatalog: RouterCatalogSource = { read: () => routerProjection() };
  const catalog = new PresentationCatalogService(
    routerCatalog,
    store,
    service.queries,
    directory,
    { now: () => new Date("2026-09-14T18:10:00.000Z") },
  );
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret,
    usageToken,
    registry: new ProviderRegistry(),
    cmmUsageService: service,
    cmmUsageCatalog: catalog,
    cmmUsageVisibility: visibility,
  } as Parameters<typeof buildServer>[0]);
  return { server, visibility };
}

function auth() {
  return { authorization: `Bearer ${usageToken}` };
}

beforeEach(() => {
  store = undefined as unknown as SqliteUsageStore;
});

afterEach(async () => {
  await store?.close();
});

describe("CMM Usage safe catalog API", () => {
  it("returns supported connected and disconnected providers without credential material", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/providers",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const serialized = response.body;
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("keychain://");
    expect(serialized).not.toContain("private-test-ref");
    expect(serialized).not.toContain("managementCredentialRef");
    const data = response.json().data as Array<{ directory: { integrationType: string; state: string } }>;
    expect(data.find((entry) => entry.directory.integrationType === "command-code")?.directory.state).toBe("connected");
    expect(data.find((entry) => entry.directory.integrationType === "chatgpt-subscription")?.directory.state).toBe("available");
    await server.close();
  });

  it("returns Router-authoritative route visibility without changing routability", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/routes",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const routes = response.json().data as Array<{
      routeId: string;
      routable: boolean;
      visibility: { visibleOn: string[] };
      usageStatus: string;
    }>;
    const hidden = routes.find((route) => route.routeId === "route:openrouter:claude");
    expect(hidden?.visibility).toEqual({ visibleOn: ["admin_console"] });
    // Hiding a route is not disconnection: Router still routes it.
    expect(hidden?.routable).toBe(true);
    // The Usage observation stays available under an explicitly historical name.
    expect(hidden?.usageStatus).toBe("available");
    expect(hidden).not.toHaveProperty("availability");
    expect(routes.find((route) => route.routeId === "route:anthropic:claude")?.visibility)
      .toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    expect(routes.find((route) => route.routeId === "route:google:claude")?.visibility)
      .toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    await server.close();
  });

  it("returns route detail, promotions, and Router-effective visibility through safe reads", async () => {
    const { server } = await fixture();
    const detail = await server.inject({
      method: "GET",
      url: `/v1/cmm/usage/catalog/routes/${encodeURIComponent("route:kira:qwen")}`,
      headers: auth(),
    });
    const promotions = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/promotions",
      headers: auth(),
    });
    const visibility = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: auth(),
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().routeId).toBe("route:kira:qwen");
    expect(promotions.statusCode).toBe(200);
    expect(promotions.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: "route:kira:qwen", offer: expect.objectContaining({ kind: "PROMO" }) }),
    ]));
    expect(visibility.statusCode).toBe(200);
    const visibilityData = visibility.json().data as Array<{
      scope: string;
      routeId: string;
      state: string;
    }>;
    // Router effective visibility, not the disagreeing SQLite preference.
    expect(visibilityData).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "global",
        routeId: "route:openrouter:claude",
        state: "hidden",
      }),
      expect.objectContaining({
        scope: "global",
        routeId: "route:anthropic:claude",
        state: "visible",
      }),
    ]));
    expect(visibilityData).toHaveLength(6);
    await server.close();
  });

  it("returns every safe quota summary once, including unbound supplemental balances", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/quotas",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const serialized = response.body;
    expect(serialized).not.toContain("credentialRef");
    expect(serialized).not.toContain("keychain://");
    const quotas = response.json().data as Array<{
      bucketId: string;
      constraining: boolean;
      affectedRouteIds?: string[];
      windowPolicy: { kind: string };
    }>;
    expect(quotas.filter((quota) => quota.bucketId === "bucket:openrouter:credits")).toHaveLength(1);
    expect(quotas.find((quota) => quota.bucketId === "bucket:openrouter:credits")?.affectedRouteIds)
      .toEqual(["route:openrouter:claude", "route:openrouter:qwen"]);
    expect(quotas.find((quota) => quota.bucketId === "bucket:cc:free")).toMatchObject({
      constraining: false,
      windowPolicy: { kind: "none" },
    });
    await server.close();
  });

  it("does not grant visibility mutation to the read-only usage credential", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { routeId: "route:openrouter:claude", state: "visible" },
    });

    // The read-only CMM Usage bearer is refused at the scope boundary: the
    // legacy visibility path is a privileged Router-administration delegate,
    // so a read credential never reaches a mutation handler.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { type: "usage_scope_forbidden" } });
    await server.close();
  });
});
