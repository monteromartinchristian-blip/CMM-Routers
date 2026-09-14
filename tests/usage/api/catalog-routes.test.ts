import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import { PresentationCatalogService } from "../../../src/usage/presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { seedCatalogScenario } from "../fixtures/catalog-scenarios.js";

const bearerSecret = "chat-bearer";
const usageToken = "catalog-read-token";
let store: SqliteUsageStore;

async function fixture() {
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
  await seedCatalogScenario(store);
  const service = new UsageService(store, new UsageAdapterManager(), {
    scheduler: { now: () => Date.parse("2026-09-14T18:10:00.000Z") },
  });
  const visibility = new VisibilityStore(store);
  await visibility.set({
    scope: "global",
    routeId: "route:openrouter:claude",
    state: "hidden",
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
  const catalog = new PresentationCatalogService(
    store,
    service.queries,
    directory,
    visibility,
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
  return { server };
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

  it("returns a route-scoped visible catalog reusable by CMMChat", async () => {
    const { server } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/routes",
      headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const routes = response.json().data as Array<{ routeId: string; visibility: string }>;
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")?.visibility).toBe("hidden");
    expect(routes.find((route) => route.routeId === "route:anthropic:claude")?.visibility).toBe("visible");
    expect(routes.find((route) => route.routeId === "route:google:claude")?.visibility).toBe("visible");
    await server.close();
  });

  it("returns route detail, promotions, and visibility preferences through safe reads", async () => {
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
    expect(visibility.json().data).toEqual([
      expect.objectContaining({ scope: "global", routeId: "route:openrouter:claude", state: "hidden" }),
    ]);
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

    expect(response.statusCode).toBe(404);
    await server.close();
  });
});
