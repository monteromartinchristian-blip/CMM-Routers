import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatalogReconciler,
  type CatalogRoutePolicy,
} from "../../../src/catalog/catalog-reconciler.js";
import { CredentialBindingStore } from "../../../src/catalog/credential-bindings.js";
import { ModelIdentityStore } from "../../../src/catalog/model-identities.js";
import {
  buildRouterCatalogProjection,
  type AccessRouteSummary,
  type AccountSummary,
  type ProviderConnectionSummary,
  type RouterCatalogProjection,
} from "../../../src/catalog/projection.js";
import { ProviderConnectionService } from "../../../src/catalog/provider-connections.js";
import { ProviderDirectory } from "../../../src/catalog/provider-directory.js";
import { RouteCatalog } from "../../../src/catalog/route-catalog.js";
import { RouteVisibilityPolicy } from "../../../src/catalog/route-visibility-policy.js";
import { RouterAdminConfigStore } from "../../../src/catalog/router-admin-config-store.js";
import { RouterAdministrationService } from "../../../src/catalog/router-administration-service.js";
import type { SecureCredentialResolver } from "../../../src/catalog/secure-credential-resolver.js";
import type {
  SecureCredentialWriteResult,
  SecureCredentialWriter,
} from "../../../src/catalog/secure-credential-writer.js";
import type { DiscoveredModel } from "../../../src/core/provider.js";
import { buildServer } from "../../../src/http/server.js";
import { ProviderRegistry } from "../../../src/registry/provider-registry.js";
import { ConnectionManagementService } from "../../../src/usage/service/connection-management-service.js";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import { createDefaultProviderDirectory } from "../../../src/usage/presentation/provider-directory.js";
import {
  PresentationCatalogService,
  type RouterCatalogSource,
} from "../../../src/usage/presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../../../src/usage/presentation/visibility-store.js";
import type { UsageAdapter } from "../../../src/usage/adapters/contract.js";
import {
  ConfiguredUsageRuntime,
  UsageIntegrationCatalog,
  type UsageCollectorBinding,
} from "../../../src/usage/runtime/configured-runtime.js";
import { createProductionUsageRuntime } from "../../../src/usage/runtime/production-runtime.js";
import { UsageService } from "../../../src/usage/service/usage-service.js";
import { UsageQueryService } from "../../../src/usage/service/usage-query-service.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import { seedCatalogScenario } from "../fixtures/catalog-scenarios.js";

const stores: SqliteUsageStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

const canonicalRoutes: readonly AccessRouteSummary[] = [
  routerRoute("route:command-code", "provider:command-code", "model:command-code", "command-code"),
  routerRoute("route:anthropic:claude", "provider:anthropic", "model:claude-sonnet", "claude-sonnet"),
  routerRoute("route:google:claude", "provider:google", "model:claude-sonnet", "claude-sonnet"),
  routerRoute("route:openrouter:claude", "provider:openrouter", "model:claude-sonnet", "anthropic/claude-sonnet"),
  routerRoute("route:openrouter:qwen", "provider:openrouter", "model:qwen-flash", "qwen/qwen-flash"),
  routerRoute("route:kira:qwen", "provider:kira", "model:qwen-flash", "qwen-flash"),
];

const canonicalProviders = [
  { providerId: "provider:command-code", displayName: "Command Code" },
  { providerId: "provider:anthropic", displayName: "Anthropic" },
  { providerId: "provider:google", displayName: "Google AI Pro" },
  { providerId: "provider:openrouter", displayName: "OpenRouter" },
  { providerId: "provider:kira", displayName: "Kira AI" },
];

const canonicalProducts = [
  { productId: "product:command-code:individual-goat", accountId: "account:command-code", providerId: "provider:command-code", kind: "subscription" as const, label: "individual-goat" },
  { productId: "product:anthropic", accountId: "account:anthropic", providerId: "provider:anthropic", kind: "subscription" as const, label: "Claude subscription" },
  { productId: "product:google", accountId: "account:google", providerId: "provider:google", kind: "subscription" as const, label: "Google AI Pro" },
  { productId: "product:openrouter", accountId: "account:openrouter", providerId: "provider:openrouter", kind: "api" as const, label: "OpenRouter credits" },
  { productId: "product:kira-promo", accountId: "account:kira", providerId: "provider:kira", kind: "promo_pool" as const, label: "Kira free access" },
];

const canonicalModels = [
  { modelIdentityId: "model:claude-sonnet", canonicalName: "Claude Sonnet", family: "Claude", aliases: ["claude-sonnet"] },
  { modelIdentityId: "model:qwen-flash", canonicalName: "Qwen Flash", family: "Qwen", aliases: ["qwen-flash"] },
  { modelIdentityId: "model:command-code", canonicalName: "Command Code", family: "Command", aliases: [] },
];

function projection(
  routes: readonly AccessRouteSummary[] = canonicalRoutes,
): RouterCatalogProjection {
  const accounts: readonly AccountSummary[] = canonicalProducts.map((product) => ({
    accountId: product.accountId,
    providerId: product.providerId,
    label: `${canonicalProviders.find((entry) => entry.providerId === product.providerId)?.displayName ?? product.providerId} account`,
    identityStatus: "resolved",
  }));
  const connections: readonly ProviderConnectionSummary[] = canonicalProducts.map((product) => ({
    connectionId: `connection:${product.providerId}`,
    providerId: product.providerId,
    accountId: product.accountId,
    productId: product.productId,
    connectionKind: "openai-chat-completions",
    status: "ready",
    identityStatus: "resolved",
  }));
  return {
    providers: canonicalProviders,
    accounts,
    products: canonicalProducts,
    connections,
    models: canonicalModels,
    routes,
  };
}

function withRoute(
  routeId: string,
  overrides: Partial<Omit<AccessRouteSummary, "routeId">>,
): RouterCatalogProjection {
  return projection(canonicalRoutes.map((route) =>
    route.routeId === routeId ? { ...route, ...overrides } : route));
}

async function setup(
  options: { projection?: RouterCatalogProjection } = {},
) {
  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  await seedCatalogScenario(store);
  const queries = new UsageQueryService(store, { now: () => new Date("2026-09-14T18:10:00.000Z") });
  const visibility = new VisibilityStore(store);
  const directory = createDefaultProviderDirectory([]);
  const catalog = new PresentationCatalogService(
    { read: () => options.projection ?? projection() },
    store,
    queries,
    directory,
    { now: () => new Date("2026-09-14T18:10:00.000Z") },
  );
  return { store, queries, visibility, directory, catalog };
}

describe("Router authority delegation for the Usage catalog", () => {
  it("copies Router identity, capabilities, routability and visibility unchanged", async () => {
    const { catalog } = await setup();
    const routes = await catalog.listRoutes();

    for (const canonical of canonicalRoutes) {
      const entry = routes.find((route) => route.routeId === canonical.routeId);
      expect(entry).toBeDefined();
      expect(entry?.modelIdentityId).toBe(canonical.modelIdentityId);
      expect(entry?.connectionId).toBe(canonical.connectionId);
      expect(entry?.providerModelId).toBe(canonical.providerModelId);
      expect(entry?.executionProfile).toBe(canonical.executionProfile);
      expect(entry?.capabilities).toEqual(canonical.capabilities);
      expect(entry?.billingClass).toBe(canonical.billingClass);
      expect(entry?.routable).toBe(canonical.routable);
      expect(entry?.visibility).toEqual(canonical.visibility);
      expect(entry?.provider.id).toBe(canonical.providerId);
      expect(entry?.account?.id).toBe(
        canonicalProducts.find((product) => product.providerId === canonical.providerId)?.accountId,
      );
      expect(entry?.model.id).toBe(canonical.modelIdentityId);
      expect(entry?.product.id).toBe(
        canonicalProducts.find((product) => product.providerId === canonical.providerId)?.productId,
      );
    }
  });

  it("attaches Usage quota, offer and freshness intelligence to Router routes", async () => {
    const { catalog } = await setup();
    const route = (await catalog.listRoutes())
      .find((entry) => entry.routeId === "route:openrouter:claude");

    expect(route?.quota).toContainEqual(expect.objectContaining({
      bucketId: "bucket:openrouter:credits",
      remaining: 7.31,
    }));
    expect(route?.offer).toMatchObject({ kind: "PAYG" });
    expect(route?.freshness).toMatchObject({
      observedAt: "2026-09-14T18:00:00.000Z",
      stale: false,
    });
  });

  it("never lets a disagreeing Usage row rewrite Router identity", async () => {
    const { store, catalog } = await setup();
    // Usage SQLite claims a different provider model id, product and display
    // name for the same canonical route id.
    await store.upsertAccessRoute({
      id: "route:anthropic:claude",
      accountId: "account:openrouter",
      productId: "product:openrouter",
      modelIdentityId: "model:qwen-flash",
      providerModelId: "usage/claimed-model",
      displayName: "Usage claimed label",
      status: "unavailable",
      metadata: {},
    });

    const route = (await catalog.listRoutes())
      .find((entry) => entry.routeId === "route:anthropic:claude");

    expect(route?.provider.id).toBe("provider:anthropic");
    expect(route?.providerModelId).toBe("claude-sonnet");
    expect(route?.modelIdentityId).toBe("model:claude-sonnet");
    expect(route?.model.displayName).toBe("Claude Sonnet");
    expect(route?.routable).toBe(true);
    expect(route?.visibility).toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    // The disagreeing Usage row claims product:openrouter, but Router's product
    // identity, user-facing label and category are all authoritative.
    expect(route?.product.id).toBe("product:anthropic");
    expect(route?.product.displayName).toBe("Claude subscription");
    expect(route?.product.category).toBe("subscription");
    // The disagreeing Usage product is `product:openrouter` (kind `api`, which
    // would project PAYG). The offer belongs to this exact Router route, so it
    // must follow Router's `subscription` product kind: INCLUDED, never PAYG.
    expect(route?.offer.kind).toBe("INCLUDED");
    // Only the explicitly historical Usage observation reflects the Usage row.
    expect(route?.usageStatus).toBe("temporarily_unavailable");
  });

  it("derives a disagreeing route offer from Router product kind, never from the disagreeing Usage product", async () => {
    const { store, catalog } = await setup();
    // The Usage row for this canonical route names a different product and
    // carries no offer metadata of its own. Router's product kind is
    // `promo_pool` (PROMO); the disagreeing Usage product is `product:openrouter`
    // (kind `api`, which would project PAYG). The route must read PROMO.
    await store.upsertAccessRoute({
      id: "route:kira:qwen",
      accountId: "account:openrouter",
      productId: "product:openrouter",
      modelIdentityId: "model:qwen-flash",
      providerModelId: "usage/claimed-qwen",
      displayName: "Usage claimed label",
      status: "available",
      metadata: {},
    });

    const route = (await catalog.listRoutes())
      .find((entry) => entry.routeId === "route:kira:qwen");

    expect(route?.product.id).toBe("product:kira-promo");
    expect(route?.offer).toEqual({ kind: "PROMO" });
  });

  it("keeps the Usage route row's own offer metadata when its product disagrees with Router", async () => {
    const { store, catalog } = await setup();
    // Same disagreement, but now the Usage *route* row carries its own offer
    // metadata. That metadata is intelligence for this exact route, so it must
    // refine the Router product kind rather than being discarded (or replaced
    // by the disagreeing product's `api`/PAYG kind).
    await store.upsertAccessRoute({
      id: "route:kira:qwen",
      accountId: "account:openrouter",
      productId: "product:openrouter",
      modelIdentityId: "model:qwen-flash",
      providerModelId: "usage/claimed-qwen",
      displayName: "Usage claimed label",
      status: "available",
      metadata: {
        offerKind: "FREE",
        offerSource: "provider_official_api",
        offerConfidence: "exact",
        offerValidUntil: "2026-09-30T23:59:59.000Z",
      },
    });

    const route = (await catalog.listRoutes())
      .find((entry) => entry.routeId === "route:kira:qwen");

    expect(route?.product.id).toBe("product:kira-promo");
    expect(route?.offer).toMatchObject({
      kind: "FREE",
      source: "provider_official_api",
      confidence: "exact",
      validUntil: "2026-09-30T23:59:59.000Z",
    });
  });

  it("still lets an agreeing Usage row refine the product label and category", async () => {
    const { catalog } = await setup();
    const routes = await catalog.listRoutes();

    // Usage and Router agree on product identity for these routes, so the
    // Usage-side friendly label and provider-kind category refinement apply.
    expect(routes.find((route) => route.routeId === "route:command-code")?.product)
      .toEqual({
        id: "product:command-code:individual-goat",
        displayName: "GOAT",
        category: "subscription",
      });
    expect(routes.find((route) => route.routeId === "route:openrouter:claude")?.product)
      .toEqual({
        id: "product:openrouter",
        displayName: "OpenRouter credits",
        category: "aggregator",
      });
    // Router's product kind is `promo_pool` (a bare "api"), but the agreeing
    // Usage provider kind `generic` refines the category to `custom`.
    expect(routes.find((route) => route.routeId === "route:kira:qwen")?.product)
      .toEqual({
        id: "product:kira-promo",
        displayName: "Kira free access",
        category: "custom",
      });
  });

  it("keeps a Usage-only route out of the operational list but in historical queries", async () => {
    const { store, queries, catalog } = await setup();
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
    expect((await catalog.listPromotions()).map((route) => route.routeId))
      .not.toContain("route:openrouter:retired");
    expect((await queries.listRoutes()).map((view) => view.route.id))
      .toContain("route:openrouter:retired");
  });

  it("keeps a hidden route routable, its siblings visible, and its Usage history intact", async () => {
    const { queries, catalog } = await setup({
      projection: withRoute("route:openrouter:claude", { visibility: { visibleOn: ["admin_console"] } }),
    });

    const routes = await catalog.listRoutes();
    const hidden = routes.find((route) => route.routeId === "route:openrouter:claude");
    expect(hidden?.visibility).toEqual({ visibleOn: ["admin_console"] });
    expect(hidden?.routable).toBe(true);
    expect(hidden?.quota).toContainEqual(expect.objectContaining({
      bucketId: "bucket:openrouter:credits",
    }));
    expect(routes.find((route) => route.routeId === "route:openrouter:qwen")?.visibility)
      .toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
    expect((await catalog.listVisibleRoutes()).map((route) => route.routeId))
      .not.toContain("route:openrouter:claude");
    // Usage collection/history is untouched by a visibility change.
    expect((await queries.listRoutes()).map((view) => view.route.id))
      .toContain("route:openrouter:claude");
    expect((await queries.listQuotas()).map((view) => view.bucket.id))
      .toContain("bucket:openrouter:credits");
  });

  it("re-reads the injected Router source on every call instead of caching a snapshot", async () => {
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    await store.initialize();
    await seedCatalogScenario(store);
    const queries = new UsageQueryService(store);
    let current = projection();
    let reads = 0;
    const catalog = new PresentationCatalogService(
      {
        read: () => {
          reads += 1;
          return current;
        },
      },
      store,
      queries,
      createDefaultProviderDirectory([]),
    );

    expect((await catalog.listRoutes()).find((route) => route.routeId === "route:openrouter:claude")?.routable)
      .toBe(true);

    current = withRoute("route:openrouter:claude", {
      routable: false,
      visibility: { visibleOn: ["admin_console"] },
    });

    const after = (await catalog.listRoutes())
      .find((route) => route.routeId === "route:openrouter:claude");
    expect(after?.routable).toBe(false);
    expect(after?.visibility).toEqual({ visibleOn: ["admin_console"] });
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("reports Router effective visibility through the compatibility read, not SQLite preferences", async () => {
    const { store, catalog, visibility } = await setup({
      projection: withRoute("route:openrouter:claude", { visibility: { visibleOn: ["admin_console"] } }),
    });
    // SQLite still records the opposite preference.
    await store.upsertVisibilityPreference({
      scope: "global",
      routeId: "route:openrouter:claude",
      state: "visible",
    });

    const service = new UsageService(store, new UsageAdapterManager(), {
      scheduler: { now: () => Date.parse("2026-09-14T18:10:00.000Z") },
    });
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "chat-bearer",
      usageToken: "catalog-read-token",
      registry: new ProviderRegistry(),
      cmmUsageService: service,
      cmmUsageCatalog: catalog,
      cmmUsageVisibility: visibility,
    } as Parameters<typeof buildServer>[0]);

    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: "Bearer catalog-read-token" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data as Array<{ routeId: string; state: string }>;
    expect(data.find((entry) => entry.routeId === "route:openrouter:claude")?.state).toBe("hidden");
    expect(data.find((entry) => entry.routeId === "route:anthropic:claude")?.state).toBe("visible");
    await server.close();
  });

  it("never fabricates an operational route when Router truth has none", async () => {
    const { catalog } = await setup({
      projection: { providers: [], accounts: [], products: [], connections: [], models: [], routes: [] },
    });

    // Usage SQLite is full of routes, but none of them is current Router truth.
    expect(await catalog.listRoutes()).toEqual([]);
    expect(await catalog.listPromotions()).toEqual([]);
    // Usage observability survives.
    expect((await catalog.listQuotaSummaries()).length).toBeGreaterThan(0);
  });

  it("accepts an in-process Router catalog source from production composition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-router-source-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, integrations: [] }));

    let reads = 0;
    const injected: RouterCatalogSource = {
      read: () => {
        reads += 1;
        return withRoute("route:anthropic:claude", {
          routable: false,
          visibility: { visibleOn: ["admin_console"] },
        });
      },
    };

    const production = await createProductionUsageRuntime({
      configDir: dir,
      databasePath: ":memory:",
      catalog: new UsageIntegrationCatalog(),
      routerCatalog: injected,
    });

    try {
      const routes = await production.presentationCatalog.listRoutes();
      expect(reads).toBeGreaterThan(0);
      expect(routes.map((route) => route.routeId)).toEqual(
        canonicalRoutes.map((route) => route.routeId),
      );
      const injectedRoute = routes.find((route) => route.routeId === "route:anthropic:claude");
      expect(injectedRoute?.routable).toBe(false);
      expect(injectedRoute?.visibility).toEqual({ visibleOn: ["admin_console"] });
      // No HTTP endpoint was ever involved: the store holds no Usage rows at all.
      expect(await production.store.listAccessRoutes()).toEqual([]);
    } finally {
      await production.close();
    }
  });

  it("does not invent operational routes when production has no Router source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-no-router-source-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, integrations: [] }));

    const production = await createProductionUsageRuntime({
      configDir: dir,
      databasePath: ":memory:",
      catalog: new UsageIntegrationCatalog(),
    });

    try {
      expect(await production.presentationCatalog.listRoutes()).toEqual([]);
    } finally {
      await production.close();
    }
  });
});

class DelegationCredentialWriter implements SecureCredentialWriter {
  readonly values = new Map<string, string>();

  async write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult> {
    const secretRef = `keychain://CMM%20Usage/${encodeURIComponent(bindingId)}`;
    this.values.set(secretRef, secret);
    return { secretRef, hint: "••••test" };
  }

  async remove(secretRef: string): Promise<void> {
    this.values.delete(secretRef);
  }
}

function delegationModel(
  upstreamModel: string,
  capability: NonNullable<DiscoveredModel["capability"]>,
): DiscoveredModel {
  return {
    id: `openrouter/${upstreamModel}`,
    provider: "openrouter",
    upstreamModel,
    displayName: upstreamModel,
    capability,
  };
}

const USAGE_JSON_ONLY = `${JSON.stringify({ version: 1, integrations: [] }, null, 2)}\n`;

async function delegationSetup() {
  const dir = mkdtempSync(join(tmpdir(), "cmm-usage-delegation-"));
  dirs.push(dir);
  writeFileSync(join(dir, "usage.json"), USAGE_JSON_ONLY);

  const store = new SqliteUsageStore(":memory:");
  stores.push(store);
  await store.initialize();
  await seedCatalogScenario(store);

  const directory = new ProviderDirectory();
  directory.register({
    providerId: "openrouter",
    displayName: "OpenRouter",
    adapterKind: "openai-compatible",
    supportedConnectionKinds: ["openai-chat-completions"],
    discoveryCapabilities: ["models"],
  });
  const credentialBindings = new CredentialBindingStore();
  const credentialWriter = new DelegationCredentialWriter();
  const credentialResolver: SecureCredentialResolver = {
    async resolve(secretRef) {
      const value = credentialWriter.values.get(secretRef);
      if (value === undefined) throw new Error("missing fixture secret");
      return { value };
    },
  };
  const providerConnections = new ProviderConnectionService({
    directory,
    credentialBindings,
    credentialResolver,
    administrativeDiscovery: new Map([
      [
        "openrouter",
        async () => [
          delegationModel("model-tools", "CHAT_AND_TOOLS"),
          delegationModel("model-chat", "CHAT_ONLY"),
        ],
      ],
    ]),
  });
  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({ connections: providerConnections, modelIdentities });
  const routeVisibilityPolicy = new RouteVisibilityPolicy();
  const routePolicy: CatalogRoutePolicy = (connection, model) => {
    const toolCapable = model.capabilities?.tools === true;
    return {
      canonicalName: `${connection.providerId}:${model.providerModelId}`,
      executionProfile: "default",
      capabilities: { chat: true, tools: toolCapable, streaming: true },
      billingClass: "api",
      routable: true,
      visibility: routeVisibilityPolicy.resolve({
        providerId: connection.providerId,
        providerModelId: model.providerModelId,
        toolCapable,
        exactRouteExecutable: true,
      }),
    };
  };
  const catalogReconciler = new CatalogReconciler({
    connections: providerConnections,
    modelIdentities,
    routeCatalog,
    routePolicy,
    minRefreshIntervalMs: 0,
  });
  const administration = new RouterAdministrationService({
    directory,
    connections: providerConnections,
    credentialBindings,
    routeCatalog,
    catalogReconciler,
    configStore: new RouterAdminConfigStore(dir),
    credentialWriter,
    routeVisibilityPolicy,
  });
  const visibility = new VisibilityStore(store);
  const connections = new ConnectionManagementService(administration, {
    routerCatalog: {
      read: () =>
        buildRouterCatalogProjection({
          directory,
          accounts: [],
          products: [],
          connections: providerConnections,
          modelIdentities,
          routeCatalog,
        }),
    },
  });

  return {
    dir,
    store,
    visibility,
    administration,
    directory,
    modelIdentities,
    providerConnections,
    routeCatalog,
    routeVisibilityPolicy,
    connections,
    usageJson: () => readFileSync(join(dir, "usage.json"), "utf8"),
    sharedConfig: () => {
      const path = join(dir, "shared.json");
      if (!existsSync(path)) return {} as { routeVisibility?: Array<{ routeId: string; visibleOn: string[] }> };
      return JSON.parse(readFileSync(path, "utf8")) as {
        routeVisibility?: Array<{ routeId: string; visibleOn: string[] }>;
      };
    },
  };
}

describe("Router authority delegation for Usage mutations", () => {
  it("delegates a compatibility connect to the canonical Router graph and not to Usage storage", async () => {
    const state = await delegationSetup();
    const before = state.usageJson();
    const historyBefore = (await state.store.listAccessRoutes()).length;

    const view = await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });

    // Router owns the connection; Usage fabricates nothing.
    expect(state.providerConnections.get("openrouter-primary")?.providerId).toBe("openrouter");
    expect(state.routeCatalog.list().map((route) => route.providerModelId).sort())
      .toEqual(["model-chat", "model-tools"]);
    expect(view).toEqual({
      id: "openrouter-primary",
      type: "openrouter",
      enabled: true,
      executionAuthorized: true,
      observabilityAuthorized: true,
    });
    // Router connection success is reported separately from observability.
    expect(JSON.stringify(view)).not.toContain("secret-value");
    expect(JSON.stringify(view)).not.toContain("keychain://");
    expect(state.usageJson()).toBe(before);
    expect((await state.store.listAccessRoutes()).length).toBe(historyBefore);
  });

  it("delegates disconnect without erasing Usage history or route visibility", async () => {
    const state = await delegationSetup();
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const route = state.routeCatalog.list()[0]!;
    await state.connections.setVisibility({ scope: "global", routeId: route.routeId, state: "hidden" });
    const before = state.usageJson();
    const historyBefore = (await state.store.listAccessRoutes()).map((entry) => entry.id).sort();

    await state.connections.disconnect("openrouter-primary");

    // Router owns connection lifecycle: the connection and its credential
    // bindings are gone from the canonical graph.
    expect(state.providerConnections.get("openrouter-primary")).toBeUndefined();
    expect(state.providerConnections.list()).toEqual([]);
    // Usage observability is untouched by a Router connection lifecycle change.
    expect((await state.store.listAccessRoutes()).map((entry) => entry.id).sort()).toEqual(historyBefore);
    expect(await state.visibility.list()).toEqual([]);
    expect(state.usageJson()).toBe(before);
  });

  it("persists legacy visibility as Router-owned state and never into Usage SQLite", async () => {
    const state = await delegationSetup();
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const routes = state.routeCatalog.list();
    const toolRoute = routes.find((entry) => entry.providerModelId === "model-tools")!;
    const chatRoute = routes.find((entry) => entry.providerModelId === "model-chat")!;
    const before = state.usageJson();

    await state.connections.setVisibility({ scope: "global", routeId: toolRoute.routeId, state: "hidden" });
    expect(state.routeCatalog.get(toolRoute.routeId)?.visibility.visibleOn).toEqual(["admin_console"]);
    // Hiding never changes routability, and never touches a sibling route.
    expect(state.routeCatalog.get(toolRoute.routeId)?.routable).toBe(true);
    expect(state.routeCatalog.get(chatRoute.routeId)?.visibility.visibleOn).toEqual([
      "cmmchat_model_picker",
      "admin_console",
    ]);
    // The exact-route rule is Router-owned persisted state.
    expect(state.sharedConfig().routeVisibility).toEqual([
      { routeId: toolRoute.routeId, visibleOn: ["admin_console"] },
    ]);

    await state.connections.setVisibility({ scope: "global", routeId: toolRoute.routeId, state: "visible" });
    expect(state.routeCatalog.get(toolRoute.routeId)?.visibility.visibleOn).toEqual([
      "cmmchat_model_picker",
      "cmmcode_model_picker",
      "admin_console",
    ]);
    await state.connections.setVisibility({ scope: "global", routeId: chatRoute.routeId, state: "visible" });
    expect(state.routeCatalog.get(chatRoute.routeId)?.visibility.visibleOn).toEqual([
      "cmmchat_model_picker",
      "admin_console",
    ]);

    // Usage SQLite never becomes an effective-visibility authority.
    expect(await state.visibility.list()).toEqual([]);
    expect(state.usageJson()).toBe(before);
  });

  it("keeps an accepted legacy visibility change authoritative across a Router reconcile", async () => {
    const state = await delegationSetup();
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const route = state.routeCatalog.list()[0]!;
    await state.connections.setVisibility({ scope: "global", routeId: route.routeId, state: "hidden" });

    await state.administration.refreshModels("openrouter-primary");

    expect(state.routeCatalog.get(route.routeId)?.visibility.visibleOn).toEqual(["admin_console"]);
  });

  it("rejects a legacy visibility mutation that names no exact route", async () => {
    const state = await delegationSetup();

    await expect(
      state.connections.setVisibility({ scope: "global", providerId: "openrouter", state: "hidden" }),
    ).rejects.toThrow();
    expect(await state.visibility.list()).toEqual([]);
    expect(state.sharedConfig().routeVisibility ?? []).toEqual([]);
  });

  it("rejects a workspace-scoped mutation instead of applying it globally", async () => {
    const state = await delegationSetup();
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const route = state.routeCatalog.list()[0]!;
    const before = state.routeCatalog.get(route.routeId)!.visibility.visibleOn;

    // Router has no workspace visibility surface. Applying this as a global
    // exact rule would silently widen a workspace preference into Router truth.
    await expect(
      state.connections.setVisibility({
        scope: "workspace:team-a",
        routeId: route.routeId,
        state: "hidden",
      }),
    ).rejects.toThrow(/global/i);
    expect(state.routeCatalog.get(route.routeId)!.visibility.visibleOn).toEqual(before);
    expect(state.sharedConfig().routeVisibility ?? []).toEqual([]);
  });

  it("rejects an inherit mutation instead of pinning the capability default over an exact rule", async () => {
    const state = await delegationSetup();
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const route = state.routeCatalog.list()[0]!;
    await state.connections.setVisibility({
      scope: "global",
      routeId: route.routeId,
      state: "hidden",
    });
    const hidden = state.routeCatalog.get(route.routeId)!.visibility.visibleOn;

    // `inherit` has no Router analogue: mapping it onto the capability default
    // would silently overwrite the exact Router rule (including a migrated
    // legacy rule) instead of failing closed.
    await expect(
      state.connections.setVisibility({
        scope: "global",
        routeId: route.routeId,
        state: "inherit",
      }),
    ).rejects.toThrow();
    expect(state.routeCatalog.get(route.routeId)!.visibility.visibleOn).toEqual(hidden);
    expect(state.sharedConfig().routeVisibility).toEqual([
      { routeId: route.routeId, visibleOn: ["admin_console"] },
    ]);
  });

  it("serves the compatibility visibility mutation through the privileged HTTP endpoint", async () => {
    const state = await delegationSetup();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "chat-bearer",
      usageToken: "catalog-read-token",
      usageManagementToken: "router-administration",
      registry: new ProviderRegistry(),
      cmmUsageConnections: state.connections,
      cmmUsageVisibility: state.visibility,
      routerAdministration: state.administration,
      catalogProjectionInput: {
        directory: state.directory,
        accounts: [],
        products: [],
        connections: state.providerConnections,
        modelIdentities: state.modelIdentities,
        routeCatalog: state.routeCatalog,
      },
    });
    await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    const route = state.routeCatalog.list()[0]!;

    const response = await server.inject({
      method: "PATCH",
      url: "/v1/cmm/usage/catalog/visibility",
      headers: { authorization: "Bearer router-administration", "content-type": "application/json" },
      payload: { routeId: route.routeId, state: "hidden" },
    });

    expect(response.statusCode).toBe(200);
    expect(state.routeCatalog.get(route.routeId)?.visibility.visibleOn).toEqual(["admin_console"]);
    expect(await state.visibility.list()).toEqual([]);
    await server.close();
  });

  it("makes a connected provider collectable through an explicit observability binding without collapsing the four states", async () => {
    const state = await delegationSetup();
    const view = await state.connections.connectWithApiKey("openrouter", "secret-value", {
      instanceId: "openrouter-primary",
    });
    // Router owns execution and observability credential authorization.
    expect(view).toMatchObject({ executionAuthorized: true, observabilityAuthorized: true });

    const projection = buildRouterCatalogProjection({
      directory: state.directory,
      accounts: [],
      products: [],
      connections: state.providerConnections,
      modelIdentities: state.modelIdentities,
      routeCatalog: state.routeCatalog,
    });
    const connection = projection.connections
      .find((entry) => entry.connectionId === "openrouter-primary")!;
    const routeIds = projection.routes
      .filter((route) => route.connectionId === connection.connectionId)
      .map((route) => route.routeId)
      .sort();
    expect(routeIds).toHaveLength(2);

    // The binding is produced from the canonical Router projection plus the
    // explicit observability binding, never from a Usage-invented identity.
    const binding: UsageCollectorBinding = {
      integrationId: "openrouter-primary",
      providerId: connection.providerId,
      ...(connection.accountId === undefined ? {} : { accountId: connection.accountId }),
      ...(connection.productId === undefined ? {} : { productId: connection.productId }),
      connectionId: connection.connectionId,
      routeIds,
      observabilityBindingId: "observability:openrouter-primary",
    };
    const unauthorized: UsageCollectorBinding = {
      integrationId: binding.integrationId,
      providerId: binding.providerId,
      ...(binding.connectionId === undefined ? {} : { connectionId: binding.connectionId }),
      routeIds: binding.routeIds,
    };

    const seen: Array<UsageCollectorBinding | undefined> = [];
    const catalog = new UsageIntegrationCatalog();
    catalog.register("openrouter", (_definition, collectorBinding) => {
      seen.push(collectorBinding);
      return inertAdapter("openrouter-primary");
    });
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    await store.initialize();
    const runtime = new ConfiguredUsageRuntime(store, catalog);
    const definition = {
      id: "openrouter-primary",
      type: "openrouter",
      enabled: true,
      settings: {},
    } as const;

    // Both: collectable and executable.
    await runtime.applyConfig({ integrations: [definition], bindings: [binding] });
    expect(runtime.collectorBindings()).toEqual([binding]);
    expect(runtime.adapters.list().map(({ id, enabled }) => ({ id, enabled }))).toEqual([{ id: "openrouter-primary", enabled: true }]);
    expect(seen.at(-1)).toEqual(binding);

    // Collected-but-not-executable is representable: Router connection
    // enablement is independent of collector enablement.
    await state.administration.setEnabled("openrouter-primary", false);
    expect(state.providerConnections.get("openrouter-primary")?.status).toBe("disabled");
    expect(runtime.adapters.list().map(({ id, enabled }) => ({ id, enabled }))).toEqual([{ id: "openrouter-primary", enabled: true }]);
    expect(runtime.collectorBindings()).toEqual([binding]);

    // Executable-but-not-collected: the Router connection is enabled again, but
    // without an observability-authorized binding the collector is not
    // collectable even though the integration definition is enabled.
    await state.administration.setEnabled("openrouter-primary", true);
    expect(state.providerConnections.get("openrouter-primary")?.status).not.toBe("disabled");
    await runtime.applyConfig({ integrations: [definition], bindings: [unauthorized] });
    expect(runtime.adapters.list().map(({ id, enabled }) => ({ id, enabled }))).toEqual([{ id: "openrouter-primary", enabled: false }]);
    expect(runtime.collectorBindings()).toEqual([unauthorized]);

    // Neither: an observability-authorized binding cannot make a disabled
    // collector collect.
    await runtime.applyConfig({
      integrations: [{ ...definition, enabled: false }],
      bindings: [binding],
    });
    expect(runtime.adapters.list().map(({ id, enabled }) => ({ id, enabled }))).toEqual([{ id: "openrouter-primary", enabled: false }]);
  });
});

function inertAdapter(id: string): UsageAdapter {
  return {
    id,
    manifest: () => ({
      id,
      displayName: id,
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: 60_000,
    }),
    capabilities: () => new Set(),
    health: async () => ({ status: "healthy" }),
    discover: async () => ({
      status: "ok",
      providers: [],
      accounts: [],
      products: [],
      models: [],
      accessRoutes: [],
    }),
    collectUsageEvents: async () => ({ status: "unsupported", capability: "collect_usage_events" }),
    collectQuotaSnapshots: async () => ({ status: "unsupported", capability: "collect_quota_snapshots" }),
    collectCostEvents: async () => ({ status: "unsupported", capability: "collect_costs" }),
    refresh: async () => ({ status: "unsupported", capability: "manual_refresh" }),
  };
}
