import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccessRouteSummary,
  ProviderConnectionSummary,
  RouterCatalogProjection,
} from "../../../src/catalog/projection.js";
import type { RouterAdministrationService } from "../../../src/catalog/router-administration-service.js";
import type { AccessRoute, RouteSurface } from "../../../src/catalog/types.js";
import { migrateLegacyVisibility } from "../../../src/usage/migration/legacy-visibility-migration.js";
import { PresentationCatalogService } from "../../../src/usage/presentation/presentation-catalog-service.js";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import type { VisibilityPreference } from "../../../src/usage/presentation/types.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import { UsageIntegrationCatalog } from "../../../src/usage/runtime/configured-runtime.js";
import {
  createProductionUsageRuntime,
  type ProductionUsageRuntimeOptions,
} from "../../../src/usage/runtime/production-runtime.js";
import { UsageQueryService } from "../../../src/usage/service/usage-query-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

const PROVIDER_ID = "provider:openrouter";
const PRODUCT_ID = "product:openrouter";
const CONNECTION_ID = "connection:openrouter";
const ACCOUNT_ID = "account:openrouter";

const ALL_SURFACES: readonly RouteSurface[] = [
  "cmmchat_model_picker",
  "cmmcode_model_picker",
  "admin_console",
];

const stores: SqliteUsageStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function legacyRows(rows: readonly VisibilityPreference[]): Promise<SqliteUsageStore> {
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  for (const row of rows) await store.upsertVisibilityPreference(row);
  return store;
}

function routeSummary(
  routeId: string,
  overrides: Partial<Omit<AccessRouteSummary, "routeId">> = {},
): AccessRouteSummary {
  return {
    routeId,
    modelIdentityId: `model:${routeId}`,
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    providerModelId: `provider-model:${routeId}`,
    executionProfile: "default",
    capabilities: { chat: true, tools: true, streaming: true },
    billingClass: "api",
    routable: true,
    visibility: { visibleOn: [...ALL_SURFACES] },
    ...overrides,
  };
}

function projection(routes: readonly AccessRouteSummary[]): RouterCatalogProjection {
  const connection: ProviderConnectionSummary = {
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    accountId: ACCOUNT_ID,
    productId: PRODUCT_ID,
    connectionKind: "openai-chat-completions",
    status: "ready",
    identityStatus: "resolved",
  };
  return {
    providers: [{ providerId: PROVIDER_ID, displayName: "OpenRouter" }],
    accounts: [
      {
        accountId: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        label: "OpenRouter account",
        identityStatus: "resolved",
      },
    ],
    products: [
      {
        productId: PRODUCT_ID,
        accountId: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        kind: "api",
        label: "OpenRouter credits",
      },
    ],
    connections: [connection],
    models: routes.map((route) => ({
      modelIdentityId: route.modelIdentityId,
      canonicalName: route.modelIdentityId,
      aliases: [],
    })),
    routes,
  };
}

function visibleOnOf(
  state: { projection: RouterCatalogProjection },
  routeId: string,
): readonly RouteSurface[] {
  return state.projection.routes.find((route) => route.routeId === routeId)!.visibility.visibleOn;
}

/**
 * Stand-in for the single Router administration authority.
 *
 * It records every visibility write and applies it to the projection, so a
 * test can observe both "did the migration mutate Router state" and the
 * resulting effective visibility.
 */
function administrationFor(state: { projection: RouterCatalogProjection }) {
  const calls: Array<{ routeId: string; visibleOn: RouteSurface[] }> = [];
  const setRouteVisibility = vi.fn(
    async (routeId: string, visibleOn: readonly RouteSurface[]): Promise<AccessRoute> => {
      const before = state.projection.routes.find((route) => route.routeId === routeId);
      if (before === undefined) throw new Error(`Unknown route: ${routeId}`);
      calls.push({ routeId, visibleOn: [...visibleOn] });
      state.projection = {
        ...state.projection,
        routes: state.projection.routes.map((route) =>
          route.routeId === routeId ? { ...route, visibility: { visibleOn: [...visibleOn] } } : route),
      };
      return {
        routeId: before.routeId,
        modelIdentityId: before.modelIdentityId,
        connectionId: before.connectionId,
        providerId: before.providerId,
        providerModelId: before.providerModelId,
        executionProfile: before.executionProfile,
        capabilities: { ...before.capabilities },
        billingClass: before.billingClass,
        routable: before.routable,
        visibility: { visibleOn: [...visibleOn] },
      };
    },
  );
  return { calls, setRouteVisibility };
}

describe("migrateLegacyVisibility", () => {
  it("migrates an exact route-scoped preference one-to-one and narrows it to hidden", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result).toEqual({
      migratedRouteIds: ["route:alpha"],
      skippedAmbiguous: [],
      skippedUnknown: [],
    });
    expect(administration.calls).toEqual([
      { routeId: "route:alpha", visibleOn: ["admin_console"] },
    ]);
    expect(visibleOnOf(state, "route:alpha")).toEqual(["admin_console"]);
    // Router routability is untouched by a visibility migration.
    expect(state.projection.routes[0]!.routable).toBe(true);
  });

  it("reports a provider-scoped row that matches several routes as ambiguous and mutates nothing", async () => {
    const store = await legacyRows([
      { scope: "global", providerId: PROVIDER_ID, state: "hidden" },
    ]);
    const state = {
      projection: projection([routeSummary("route:alpha"), routeSummary("route:beta")]),
    };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual([`global provider=${PROVIDER_ID}`]);
    expect(result.skippedUnknown).toEqual([]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
    expect(visibleOnOf(state, "route:beta")).toEqual(ALL_SURFACES);
  });

  it("reports a product-scoped row as ambiguous and mutates nothing", async () => {
    const store = await legacyRows([
      { scope: "global", productId: PRODUCT_ID, state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual([`global product=${PRODUCT_ID}`]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
  });

  it("reports an unknown route without creating Router state", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:retired", state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual([]);
    expect(result.skippedUnknown).toEqual(["route:retired"]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(state.projection.routes.map((route) => route.routeId)).toEqual(["route:alpha"]);
  });

  it("never broadens visibility when migrating a hidden preference", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);
    const before = visibleOnOf(state, "route:alpha");

    await migrateLegacyVisibility(new VisibilityStore(store), state.projection, administration);

    const after = visibleOnOf(state, "route:alpha");
    expect(after).toEqual(["admin_console"]);
    // Strict subset: no surface was added, and no consumer surface survived.
    expect(after.every((surface) => before.includes(surface))).toBe(true);
    expect(after.length).toBeLessThan(before.length);
    expect(after).not.toContain("cmmchat_model_picker");
    expect(after).not.toContain("cmmcode_model_picker");
  });

  it("never promotes a legacy visible preference onto a route Router currently hides", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "visible" },
    ]);
    const state = {
      projection: projection([
        routeSummary("route:alpha", { visibility: { visibleOn: ["admin_console"] } }),
      ]),
    };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    // Honouring it would broaden Router visibility, so it fails closed.
    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual(["global route=route:alpha"]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(["admin_console"]);
  });

  it("is idempotent: a second run writes nothing and reports the same result", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const first = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );
    const second = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(first).toEqual(second);
    expect(first.migratedRouteIds).toEqual(["route:alpha"]);
    expect(administration.setRouteVisibility).toHaveBeenCalledTimes(1);
    expect(visibleOnOf(state, "route:alpha")).toEqual(["admin_console"]);
    // The legacy rows are never deleted by the first migration step.
    expect(await store.listVisibilityPreferences()).toEqual([
      { scope: "global", routeId: "route:alpha", state: "hidden" },
    ]);
  });

  it("never promotes a workspace-scoped preference into global Router state", async () => {
    const store = await legacyRows([
      { scope: "workspace:team-a", routeId: "route:alpha", state: "hidden" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual(["workspace:team-a route=route:alpha"]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
  });

  it("never applies an inherit row over the current Router rule", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "inherit" },
    ]);
    const state = {
      projection: projection([
        routeSummary("route:alpha", { visibility: { visibleOn: ["admin_console"] } }),
      ]),
    };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual(["global route=route:alpha"]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(["admin_console"]);
  });

  it("fails closed when a route-scoped row contradicts the route it names", async () => {
    const store = await legacyRows([
      {
        scope: "global",
        providerId: "provider:someone-else",
        routeId: "route:alpha",
        state: "hidden",
      },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual([
      "global provider=provider:someone-else route=route:alpha",
    ]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
  });

  it("fails closed when several legacy rows resolve to the same route", async () => {
    const store = await legacyRows([
      { scope: "global", routeId: "route:alpha", state: "hidden" },
      { scope: "global", providerId: PROVIDER_ID, routeId: "route:alpha", state: "visible" },
    ]);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const result = await migrateLegacyVisibility(
      new VisibilityStore(store),
      state.projection,
      administration,
    );

    expect(result.migratedRouteIds).toEqual([]);
    expect(result.skippedAmbiguous).toEqual([
      "global provider=provider:openrouter route=route:alpha",
      "global route=route:alpha",
    ]);
    expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
  });

  it("keeps Router effective visibility authoritative after migration even when the legacy row disagrees", async () => {
    const store = await legacyRows([
      // The legacy row claims the route is visible; Router hides it.
      { scope: "global", routeId: "route:hidden", state: "visible" },
      // The legacy row claims the route is hidden; Router already hides it.
      { scope: "global", routeId: "route:agrees", state: "hidden" },
    ]);
    const state = {
      projection: projection([
        routeSummary("route:hidden", { visibility: { visibleOn: ["admin_console"] } }),
        routeSummary("route:agrees", { visibility: { visibleOn: ["admin_console"] } }),
      ]),
    };
    const administration = administrationFor(state);

    await migrateLegacyVisibility(new VisibilityStore(store), state.projection, administration);

    const catalog = new PresentationCatalogService(
      { read: () => state.projection },
      store,
      new UsageQueryService(store, { now: () => new Date("2026-09-16T12:00:00.000Z") }),
      createDefaultProviderDirectory(),
    );

    const visibility = await catalog.listRouteVisibility();
    expect(visibility.find((entry) => entry.routeId === "route:hidden")?.state).toBe("hidden");
    expect(visibility.find((entry) => entry.routeId === "route:agrees")?.state).toBe("hidden");
    expect((await catalog.listVisibleRoutes()).map((route) => route.routeId)).toEqual([]);
    // The disagreeing legacy row is still stored, and still not consulted.
    expect((await store.listVisibilityPreferences()).length).toBe(2);
  });
});

describe("production runtime legacy visibility migration entry point", () => {
  function runtimeOptions(
    state: { projection: RouterCatalogProjection },
    dir: string,
  ): ProductionUsageRuntimeOptions {
    return {
      configDir: dir,
      databasePath: ":memory:",
      catalog: new UsageIntegrationCatalog(),
      routerCatalog: { read: () => state.projection },
    };
  }

  it("migrates once on demand and never automatically at construction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-runtime-migration-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, integrations: [] }));
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const production = await createProductionUsageRuntime({
      ...runtimeOptions(state, dir),
      routerAdministration: administration as unknown as RouterAdministrationService,
    });
    try {
      await production.store.upsertVisibilityPreference({
        scope: "global",
        routeId: "route:alpha",
        state: "hidden",
      });

      // Constructing the runtime must not mutate Router state: re-running a
      // migration at boot would override later Router decisions.
      expect(administration.setRouteVisibility).not.toHaveBeenCalled();

      const result = await production.migrateLegacyVisibility();

      expect(result).toEqual({
        migratedRouteIds: ["route:alpha"],
        skippedAmbiguous: [],
        skippedUnknown: [],
      });
      expect(administration.calls).toEqual([
        { routeId: "route:alpha", visibleOn: ["admin_console"] },
      ]);
    } finally {
      await production.close();
    }
  });

  it("reports nothing to migrate when no Router authority is wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-runtime-no-admin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, integrations: [] }));
    const state = { projection: projection([routeSummary("route:alpha")]) };

    const production = await createProductionUsageRuntime(runtimeOptions(state, dir));
    try {
      await production.store.upsertVisibilityPreference({
        scope: "global",
        routeId: "route:alpha",
        state: "hidden",
      });

      expect(await production.migrateLegacyVisibility()).toEqual({
        migratedRouteIds: [],
        skippedAmbiguous: [],
        skippedUnknown: [],
      });
      expect(visibleOnOf(state, "route:alpha")).toEqual(ALL_SURFACES);
      expect((await production.store.listVisibilityPreferences()).length).toBe(1);
    } finally {
      await production.close();
    }
  });

  it("never migrates in demo mode even when a Router authority is supplied", async () => {
    vi.stubEnv("CMM_USAGE_DEMO_FIXTURE", "1");
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-runtime-demo-"));
    dirs.push(dir);
    const state = { projection: projection([routeSummary("route:alpha")]) };
    const administration = administrationFor(state);

    const production = await createProductionUsageRuntime({
      ...runtimeOptions(state, dir),
      routerAdministration: administration as unknown as RouterAdministrationService,
    });
    try {
      await production.store.upsertVisibilityPreference({
        scope: "global",
        routeId: "route:alpha",
        state: "hidden",
      });

      expect(await production.migrateLegacyVisibility()).toEqual({
        migratedRouteIds: [],
        skippedAmbiguous: [],
        skippedUnknown: [],
      });
      expect(administration.setRouteVisibility).not.toHaveBeenCalled();
    } finally {
      await production.close();
    }
  });
});
