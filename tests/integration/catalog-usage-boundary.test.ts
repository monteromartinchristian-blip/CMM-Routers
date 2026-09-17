import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogReconciler } from "../../src/catalog/catalog-reconciler.js";
import { CredentialBindingStore } from "../../src/catalog/credential-bindings.js";
import { buildModelIdentityId, buildRouteId } from "../../src/catalog/ids.js";
import { ModelIdentityStore } from "../../src/catalog/model-identities.js";
import { buildRouterCatalogProjection } from "../../src/catalog/projection.js";
import { ProviderConnectionService } from "../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../src/catalog/route-catalog.js";
import { RouteVisibilityPolicy } from "../../src/catalog/route-visibility-policy.js";
import { RouterAdminConfigStore } from "../../src/catalog/router-admin-config-store.js";
import { RouterAdministrationService } from "../../src/catalog/router-administration-service.js";
import type { SecureCredentialWriter } from "../../src/catalog/secure-credential-writer.js";
import type {
  AccessRoute,
  Account,
  ProviderProduct,
} from "../../src/catalog/types.js";
import type { UsageEvent } from "../../src/usage/domain/types.js";
import { migrateLegacyVisibility } from "../../src/usage/migration/legacy-visibility-migration.js";
import { PresentationCatalogService } from "../../src/usage/presentation/presentation-catalog-service.js";
import { createDefaultProviderDirectory } from "../../src/usage/presentation/provider-directory.js";
import { VisibilityStore } from "../../src/usage/presentation/visibility-store.js";
import { UsageQueryService } from "../../src/usage/service/usage-query-service.js";
import { SqliteUsageStore } from "../../src/usage/storage/sqlite-usage-store.js";
import { InMemorySecureCredentialResolver } from "../support/in-memory-secure-credential-resolver.js";

const PROVIDER_ID = "openrouter";
const ACCOUNT_ID = "account-openrouter";
const PRODUCT_ID = "product-openrouter";
const CONNECTION_ID = "connection-openrouter";
const EXECUTION_BINDING_ID = "execution-openrouter";
const OBSERVABILITY_BINDING_ID = "observability-openrouter";
const SECRET_REF = "keychain://openrouter/shared-boundary-secret";
const PROVIDER_MODEL_ID = "openrouter/model-boundary";

interface SetupOptions {
  execution?: boolean;
  observability?: boolean;
  hidden?: boolean;
}

function setup(options: SetupOptions = {}) {
  const directory = new ProviderDirectory();
  directory.register({
    providerId: PROVIDER_ID,
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });

  const accounts: Account[] = [
    {
      accountId: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      label: "OpenRouter Account",
      identityStatus: "unresolved",
    },
  ];
  const products: ProviderProduct[] = [
    {
      productId: PRODUCT_ID,
      accountId: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      kind: "api",
      label: "OpenRouter API",
    },
  ];

  const credentialBindings = new CredentialBindingStore();
  if (options.observability ?? true) {
    credentialBindings.addObservability({
      bindingId: OBSERVABILITY_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "observability",
      enabled: true,
    });
  }
  if (options.execution ?? false) {
    credentialBindings.addExecution({
      bindingId: EXECUTION_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "execution",
      enabled: true,
    });
  }

  const providerConnections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver: new InMemorySecureCredentialResolver(
      new Map([[SECRET_REF, "boundary-fixture-secret"]]),
    ),
    administrativeDiscovery: new Map(),
  });
  providerConnections.add({
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    accountId: ACCOUNT_ID,
    productId: PRODUCT_ID,
    connectionKind: "openai-chat-completions",
    executionCredentialBindingId: EXECUTION_BINDING_ID,
    endpointRef: "https://openrouter.example/v1",
    status: "configured",
  });

  const modelIdentities = new ModelIdentityStore();
  const modelIdentityId = buildModelIdentityId({ canonicalName: "Boundary Model" });
  modelIdentities.upsertExplicit({
    modelIdentityId,
    canonicalName: "Boundary Model",
    aliases: ["boundary-model"],
  });
  modelIdentities.bindProviderModel({
    providerId: PROVIDER_ID,
    connectionId: CONNECTION_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelIdentityId,
  });

  const routeCatalog = new RouteCatalog({
    connections: providerConnections,
    modelIdentities,
  });
  const route: AccessRoute = {
    routeId: buildRouteId({
      providerId: PROVIDER_ID,
      connectionId: CONNECTION_ID,
      providerModelId: PROVIDER_MODEL_ID,
      executionProfile: "default",
    }),
    modelIdentityId,
    connectionId: CONNECTION_ID,
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    executionProfile: "default",
    capabilities: { chat: true, tools: false, streaming: true },
    billingClass: "api",
    routable: true,
    visibility: {
      visibleOn: options.hidden
        ? ["admin_console"]
        : ["cmmchat_model_picker", "admin_console"],
    },
  };
  routeCatalog.upsert(route);

  const projectionInput = {
    directory,
    accounts,
    products,
    connections: providerConnections,
    modelIdentities,
    routeCatalog,
  };

  return {
    credentialBindings,
    directory,
    modelIdentities,
    providerConnections,
    projectionInput,
    route,
    routeCatalog,
  };
}

describe("Routers ↔ Usage catalog responsibility boundary", () => {
  it("does not authorize execution from an observability-only OpenRouter credential", async () => {
    const state = setup({ observability: true, execution: false });

    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toMatchObject({ purpose: "observability", secretRef: SECRET_REF });
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toBeUndefined();
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);
  });

  it("makes execution eligible only after an explicit execution binding exists for the same secretRef", async () => {
    const state = setup({ observability: true, execution: false });

    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);

    state.credentialBindings.addExecution({
      bindingId: EXECUTION_BINDING_ID,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      secretRef: SECRET_REF,
      purpose: "execution",
      enabled: true,
    });

    expect(
      state.credentialBindings.getExecution(EXECUTION_BINDING_ID)?.secretRef,
    ).toBe(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID)?.secretRef,
    );
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).resolves.toEqual(state.route);
  });

  it("removing observability leaves execution authorization intact", async () => {
    const state = setup({ observability: true, execution: true });

    expect(
      state.credentialBindings.removeObservability(OBSERVABILITY_BINDING_ID),
    ).toBe(true);
    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toBeUndefined();
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toMatchObject({
      purpose: "execution",
      secretRef: SECRET_REF,
    });
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).resolves.toEqual(state.route);
  });

  it("removing execution fails the route closed while observability remains", async () => {
    const state = setup({ observability: true, execution: true });

    expect(state.credentialBindings.removeExecution(EXECUTION_BINDING_ID)).toBe(true);
    expect(state.credentialBindings.getExecution(EXECUTION_BINDING_ID)).toBeUndefined();
    expect(
      state.credentialBindings.getObservability(OBSERVABILITY_BINDING_ID),
    ).toMatchObject({ purpose: "observability", secretRef: SECRET_REF });
    await expect(
      state.routeCatalog.resolveForConsumer(
        state.route.routeId,
        "cmmchat_model_picker",
      ),
    ).rejects.toThrow(/execution credential/i);
  });

  it("keeps hidden routes in the read-only Usage/admin projection", () => {
    const state = setup({ observability: true, execution: true });
    state.routeCatalog.setVisibility(state.route.routeId, ["admin_console"]);

    const projection = buildRouterCatalogProjection(state.projectionInput);

    expect(projection.routes).toContainEqual(
      expect.objectContaining({
        routeId: state.route.routeId,
        visibility: { visibleOn: ["admin_console"] },
      }),
    );
  });

  it("does not let a Usage-only fake provider become canonical Router state", () => {
    const state = setup({ observability: true, execution: true });
    const canonical = buildRouterCatalogProjection(state.projectionInput);
    const usageFixture = {
      ...canonical,
      providers: [
        ...canonical.providers,
        { providerId: "demo-provider", displayName: "Demo Provider" },
      ],
    };

    expect(usageFixture.providers.some((entry) => entry.providerId === "demo-provider")).toBe(
      true,
    );
    expect(state.directory.has("demo-provider")).toBe(false);
    expect(
      buildRouterCatalogProjection(state.projectionInput).providers.some(
        (entry) => entry.providerId === "demo-provider",
      ),
    ).toBe(false);
  });

  it("keeps canonical RouteCatalog immutable from consumer projection mutation attempts", () => {
    const state = setup({ observability: true, execution: true });
    const projection = buildRouterCatalogProjection(state.projectionInput);
    const projectedRoute = projection.routes[0] as unknown as {
      routable: boolean;
      visibility: { visibleOn: string[] };
    };

    projectedRoute.routable = false;
    projectedRoute.visibility.visibleOn.push("usage_fixture_only");

    expect(state.routeCatalog.get(state.route.routeId)).toEqual(state.route);
    expect(buildRouterCatalogProjection(state.projectionInput).routes[0]).toEqual(
      expect.objectContaining({
        routeId: state.route.routeId,
        routable: true,
        visibility: {
          visibleOn: ["cmmchat_model_picker", "admin_console"],
        },
      }),
    );
  });

  it("Router disconnect removes operational authority without deleting Usage history", async () => {
    const state = setup({ observability: true, execution: true });
    const root = mkdtempSync(join(tmpdir(), "cmm-router-usage-boundary-"));
    const usageStore = new SqliteUsageStore(join(root, "usage.sqlite"));
    await usageStore.initialize();
    const timestamp = "2026-09-16T10:00:00.000Z";
    await usageStore.upsertProvider({
      id: PROVIDER_ID,
      displayName: "OpenRouter history fixture",
      kind: "aggregator",
      status: "active",
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await usageStore.upsertAccount({
      id: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      label: "History account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await usageStore.upsertProduct({
      id: PRODUCT_ID,
      providerId: PROVIDER_ID,
      displayName: "History product",
      kind: "api",
      metadata: {},
    });
    const history: UsageEvent = {
      id: "usage-history-kept",
      occurredAt: timestamp,
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      requests: 1,
      source: "router_measured",
      confidence: "measured",
      metadata: { fixture: "must-survive-router-disconnect" },
    };
    await usageStore.appendUsageEvents([history]);

    const reconciler = new CatalogReconciler({
      connections: state.providerConnections,
      modelIdentities: state.modelIdentities,
      routeCatalog: state.routeCatalog,
      routePolicy: (_connection, model) => ({
        canonicalName: model.providerModelId,
        executionProfile: "default",
        capabilities: { chat: true, tools: false, streaming: true },
        billingClass: "api",
        routable: true,
        visibility: { visibleOn: ["admin_console"] },
      }),
      minRefreshIntervalMs: 0,
    });
    const credentialWriter: SecureCredentialWriter = {
      async write() {
        throw new Error("unused in disconnect boundary test");
      },
      async remove() {},
    };
    const administration = new RouterAdministrationService({
      directory: state.directory,
      connections: state.providerConnections,
      credentialBindings: state.credentialBindings,
      routeCatalog: state.routeCatalog,
      catalogReconciler: reconciler,
      configStore: new RouterAdminConfigStore(join(root, "router-config")),
      credentialWriter,
      routeVisibilityPolicy: new RouteVisibilityPolicy(),
    });

    try {
      await administration.disconnect(CONNECTION_ID);

      expect(state.providerConnections.get(CONNECTION_ID)).toBeUndefined();
      expect(await usageStore.listUsageEvents()).toEqual([history]);
    } finally {
      await usageStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Legacy Usage visibility migration boundary", () => {
  function migrationAdministration(state: ReturnType<typeof setup>, root: string) {
    const reconciler = new CatalogReconciler({
      connections: state.providerConnections,
      modelIdentities: state.modelIdentities,
      routeCatalog: state.routeCatalog,
      routePolicy: (_connection, model) => ({
        canonicalName: model.providerModelId,
        executionProfile: "default",
        capabilities: { chat: true, tools: false, streaming: true },
        billingClass: "api",
        routable: true,
        visibility: { visibleOn: ["admin_console"] },
      }),
      minRefreshIntervalMs: 0,
    });
    const credentialWriter: SecureCredentialWriter = {
      async write() {
        throw new Error("unused in legacy visibility migration test");
      },
      async remove() {},
    };
    return new RouterAdministrationService({
      directory: state.directory,
      connections: state.providerConnections,
      credentialBindings: state.credentialBindings,
      routeCatalog: state.routeCatalog,
      catalogReconciler: reconciler,
      configStore: new RouterAdminConfigStore(join(root, "router-config")),
      credentialWriter,
      routeVisibilityPolicy: new RouteVisibilityPolicy(),
    });
  }

  function usageCatalog(state: ReturnType<typeof setup>, usageStore: SqliteUsageStore) {
    return new PresentationCatalogService(
      { read: () => buildRouterCatalogProjection(state.projectionInput) },
      usageStore,
      new UsageQueryService(usageStore),
      createDefaultProviderDirectory(),
    );
  }

  it("promotes only an unambiguous route-scoped preference into exact Router state", async () => {
    const state = setup({ observability: true, execution: true });
    const root = mkdtempSync(join(tmpdir(), "cmm-usage-legacy-visibility-"));
    const usageStore = new SqliteUsageStore(join(root, "usage.sqlite"));
    await usageStore.initialize();

    // A sibling route on the same connection: an exact-route migration must
    // never take it with it.
    const siblingModelIdentityId = buildModelIdentityId({ canonicalName: "Sibling Model" });
    const siblingProviderModelId = "openrouter/sibling-boundary";
    state.modelIdentities.upsertExplicit({
      modelIdentityId: siblingModelIdentityId,
      canonicalName: "Sibling Model",
      aliases: [],
    });
    state.modelIdentities.bindProviderModel({
      providerId: PROVIDER_ID,
      connectionId: CONNECTION_ID,
      providerModelId: siblingProviderModelId,
      modelIdentityId: siblingModelIdentityId,
    });
    const siblingRoute: AccessRoute = {
      ...state.route,
      routeId: buildRouteId({
        providerId: PROVIDER_ID,
        connectionId: CONNECTION_ID,
        providerModelId: siblingProviderModelId,
        executionProfile: "default",
      }),
      modelIdentityId: siblingModelIdentityId,
      providerModelId: siblingProviderModelId,
    };
    state.routeCatalog.upsert(siblingRoute);

    await usageStore.upsertVisibilityPreference({
      scope: "global",
      routeId: state.route.routeId,
      state: "hidden",
    });
    await usageStore.upsertVisibilityPreference({
      scope: "workspace:team-a",
      routeId: state.route.routeId,
      state: "hidden",
    });
    await usageStore.upsertVisibilityPreference({
      scope: "global",
      routeId: "route:retired",
      state: "hidden",
    });

    try {
      const result = await migrateLegacyVisibility(
        new VisibilityStore(usageStore),
        buildRouterCatalogProjection(state.projectionInput),
        migrationAdministration(state, root),
      );

      expect(result.migratedRouteIds).toEqual([state.route.routeId]);
      expect(result.skippedAmbiguous).toEqual([`workspace:team-a route=${state.route.routeId}`]);
      expect(result.skippedUnknown).toEqual(["route:retired"]);

      const migrated = state.routeCatalog.get(state.route.routeId)!;
      expect(migrated.visibility.visibleOn).toEqual(["admin_console"]);
      // Visibility is independent of routability and of sibling routes.
      expect(migrated.routable).toBe(true);
      expect(state.routeCatalog.get(siblingRoute.routeId)!.visibility.visibleOn)
        .toEqual(state.route.visibility.visibleOn);
      // No Router route is invented for an unknown legacy route id.
      expect(buildRouterCatalogProjection(state.projectionInput).routes.map((route) => route.routeId))
        .toEqual([state.route.routeId, siblingRoute.routeId]);
      // Router state, not SQLite: every legacy row is still stored.
      expect((await usageStore.listVisibilityPreferences()).length).toBe(3);

      const catalog = usageCatalog(state, usageStore);
      const visibility = await catalog.listRouteVisibility();
      expect(visibility.find((entry) => entry.routeId === state.route.routeId)?.state).toBe("hidden");
      expect((await catalog.listVisibleRoutes()).map((route) => route.routeId))
        .toEqual([siblingRoute.routeId]);
    } finally {
      await usageStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never broadens Router visibility from a disagreeing legacy preference", async () => {
    const state = setup({ observability: true, execution: true, hidden: true });
    const root = mkdtempSync(join(tmpdir(), "cmm-usage-legacy-no-broaden-"));
    const usageStore = new SqliteUsageStore(join(root, "usage.sqlite"));
    await usageStore.initialize();
    // Router hides the route; the legacy row asks for it to be visible.
    await usageStore.upsertVisibilityPreference({
      scope: "global",
      routeId: state.route.routeId,
      state: "visible",
    });

    try {
      const result = await migrateLegacyVisibility(
        new VisibilityStore(usageStore),
        buildRouterCatalogProjection(state.projectionInput),
        migrationAdministration(state, root),
      );

      expect(result).toEqual({
        migratedRouteIds: [],
        skippedAmbiguous: [`global route=${state.route.routeId}`],
        skippedUnknown: [],
      });
      expect(state.routeCatalog.get(state.route.routeId)!.visibility.visibleOn)
        .toEqual(["admin_console"]);
      // Usage reads Router truth, so the route stays hidden.
      const catalog = usageCatalog(state, usageStore);
      expect((await catalog.listRouteVisibility()).find((entry) => entry.routeId === state.route.routeId)?.state)
        .toBe("hidden");
    } finally {
      await usageStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
