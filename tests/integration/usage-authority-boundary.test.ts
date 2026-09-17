import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteUsageStore } from "../../src/usage/storage/sqlite-usage-store.js";
import { UsageAdapterManager } from "../../src/usage/adapters/adapter-manager.js";
import { UsageService } from "../../src/usage/service/usage-service.js";
import { UsageQueryService } from "../../src/usage/service/usage-query-service.js";
import { createDefaultProviderDirectory } from "../../src/usage/presentation/provider-directory.js";
import {
  PresentationCatalogService,
  type RouterCatalogSource,
} from "../../src/usage/presentation/presentation-catalog-service.js";
import type { RouterCatalogProjection } from "../../src/catalog/projection.js";

const repoRoot = join(process.cwd(), "src");

async function source(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf8");
}

/** Source text with comments stripped, so prose cannot satisfy a guard. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("Usage authority boundary guards", () => {
  it("production Usage presentation never imports VisibilityStore as effective state", async () => {
    const presentation = await source("usage/presentation/presentation-catalog-service.ts");
    const catalogRoutes = await source("usage/api/catalog-routes.ts");

    // The presentation service must not reference the legacy store at all.
    expect(stripComments(presentation)).not.toMatch(/VisibilityStore/);
    // The catalog HTTP layer must not read it either (only a dead optional
    // parameter is tolerated, and that has been removed).
    expect(stripComments(catalogRoutes)).not.toMatch(/VisibilityStore/);
  });

  it("retains VisibilityStore only for migration and history, never for current authority", async () => {
    const migration = await source("usage/migration/legacy-visibility-migration.ts");
    // The migration is the one legitimate consumer: it needs `list` to read
    // legacy rows. It must never *write* them back.
    expect(stripComments(migration)).toMatch(/Pick<VisibilityStore, "list">/);
    expect(stripComments(migration)).not.toMatch(/upsertVisibilityPreference/);
    // `legacy` is read-only: the only write target is the Router authority.
    expect(stripComments(migration)).not.toMatch(/legacy\.set\(/);
    expect(stripComments(migration)).toMatch(/admin\.setRouteVisibility\(/);
  });

  it("integration-catalog contains no canonical operational ID fabrication", async () => {
    const catalog = await source("usage/runtime/integration-catalog.ts");
    const code = stripComments(catalog);
    for (const prefix of ["provider:custom:", "account:custom:", "product:custom:", "route:custom:"]) {
      expect(code).not.toContain(prefix);
    }
    // Usage-owned operational settings must also be gone.
    expect(code).not.toMatch(/useInCmmChat|discoverModels/);
  });

  it("connection mutation has no ManagedConfigStore dependency", async () => {
    const connections = await source("usage/service/connection-management-service.ts");
    expect(stripComments(connections)).not.toMatch(/ManagedConfigStore/);
  });
});

describe("Usage SQLite visibility rows cannot override Router current visibility", () => {
  const routes = [
    {
      routeId: "route:router:one",
      modelIdentityId: "model:one",
      connectionId: "connection:one",
      providerId: "provider:router",
      providerModelId: "model-one",
      executionProfile: "default",
      capabilities: { chat: true, tools: true, streaming: true },
      billingClass: "subscription",
      routable: true,
      visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] as const },
    },
  ];

  function projection(): RouterCatalogProjection {
    return {
      providers: [{ providerId: "provider:router", displayName: "Router" }],
      accounts: [
        {
          accountId: "account:router",
          providerId: "provider:router",
          label: "Router account",
          identityStatus: "resolved",
        },
      ],
      products: [
        {
          productId: "product:router",
          accountId: "account:router",
          providerId: "provider:router",
          kind: "subscription",
          label: "Router plan",
        },
      ],
      connections: [
        {
          connectionId: "connection:one",
          providerId: "provider:router",
          accountId: "account:router",
          productId: "product:router",
          connectionKind: "openai-chat-completions",
          status: "ready",
          identityStatus: "resolved",
        },
      ],
      models: [{ modelIdentityId: "model:one", canonicalName: "One", aliases: [] }],
      routes,
    };
  }

  let store: SqliteUsageStore;

  beforeEach(async () => {
    store = new SqliteUsageStore(":memory:");
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it("reports Router visibility even when a legacy SQLite preference disagrees", async () => {
    // A legacy row claims the route is hidden from everything.
    await store.upsertVisibilityPreference({
      scope: "global",
      routeId: "route:router:one",
      state: "hidden",
    });

    const queries = new UsageQueryService(store, { now: () => new Date("2026-09-14T18:10:00.000Z") });
    const catalog = new PresentationCatalogService(
      { read: () => projection() } as RouterCatalogSource,
      store,
      queries,
      createDefaultProviderDirectory(),
      { now: () => new Date("2026-09-14T18:10:00.000Z") },
    );

    await store.upsertProvider({
      id: "provider:router",
      displayName: "Router",
      kind: "first_party",
      status: "enabled",
      metadata: {},
      createdAt: "2026-09-14T18:00:00.000Z",
      updatedAt: "2026-09-14T18:00:00.000Z",
    });
    await store.upsertAccount({
      id: "account:router",
      providerId: "provider:router",
      label: "Router account",
      status: "active",
      createdAt: "2026-09-14T18:00:00.000Z",
      updatedAt: "2026-09-14T18:00:00.000Z",
    });
    await store.upsertProduct({
      id: "product:router",
      providerId: "provider:router",
      displayName: "Router plan",
      kind: "subscription",
      metadata: {},
    });
    await store.upsertModelIdentity({
      id: "model:one",
      canonicalName: "One",
      vendor: "Router",
      lifecycle: "active",
      aliases: [],
      metadata: {},
    });
    await store.upsertAccessRoute({
      id: "route:router:one",
      accountId: "account:router",
      productId: "product:router",
      modelIdentityId: "model:one",
      providerModelId: "model-one",
      displayName: "One",
      status: "available",
      metadata: {},
    });

    const [route] = await catalog.listRoutes();
    // Router truth wins: the route stays visible on the picker surfaces.
    expect(route?.routeId).toBe("route:router:one");
    expect(route?.visibility.visibleOn).toContain("cmmchat_model_picker");
    // And the legacy row was not deleted — it is retained for migration/history.
    const retained = await store.listVisibilityPreferences();
    expect(retained.some((row) => row.routeId === "route:router:one")).toBe(true);
  });

  it("never instantiates a Usage service that writes Router operational state", async () => {
    // Usage's own construction must not require or create Router authority.
    const service = new UsageService(store, new UsageAdapterManager());
    expect(service).toBeDefined();
    expect((service as unknown as Record<string, unknown>).routerAdministration).toBeUndefined();
  });
});
