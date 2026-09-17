import { homedir } from "node:os";
import { join } from "node:path";
import type { RouterCatalogProjection } from "../../catalog/projection.js";
import type { RouterAdministrationService } from "../../catalog/router-administration-service.js";
import type { ProductKind } from "../../catalog/types.js";
import { SqliteUsageStore } from "../storage/sqlite-usage-store.js";
import type { UsageStore } from "../storage/usage-store.js";
import { ConfiguredUsageRuntime, UsageIntegrationCatalog } from "./configured-runtime.js";
import { loadUsageRuntimeConfig, type LoadedUsageRuntimeConfig } from "./config.js";
import { LocalSecureCredentialResolver } from "./credential-resolver.js";
import {
  createDefaultUsageIntegrationCatalog,
  type SecureCredentialResolver,
} from "./integration-catalog.js";
import type { UsageServiceOptions } from "../service/usage-service.js";
import {
  migrateLegacyVisibility as runLegacyVisibilityMigration,
  type LegacyVisibilityMigrationResult,
} from "../migration/legacy-visibility-migration.js";
import { createDefaultProviderDirectory } from "../presentation/provider-directory.js";
import {
  emptyRouterCatalogSource,
  PresentationCatalogService,
  type RouterCatalogSource,
} from "../presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../presentation/visibility-store.js";
import { ConnectionManagementService } from "../service/connection-management-service.js";
import {
  PUBLIC_SAFE_DEMO_CONFIG,
  PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
  PUBLIC_SAFE_DEMO_READ_TOKEN,
  createPublicSafeDemoIntegrationCatalog,
  seedPublicSafeCatalogFixture,
} from "../demo/public-safe-catalog-fixture.js";

/**
 * The demo-mode discriminator for the Node process.
 *
 * Demo mode is triggered by `CMM_USAGE_DEMO_FIXTURE=1`. Within this process
 * both the Usage runtime and the composition root (`createProductionServer`)
 * derive it through this function, so the synthetic-fixture boundary and the
 * real-Router isolation boundary can never diverge here.
 *
 * This is not the only place the key is read: the macOS client is a separate
 * process and evaluates the same environment variable independently, only to
 * select its credential store
 * (`apps/cmm-usage-macos/Sources/CMMUsageCore/Module.swift`), which this
 * function cannot observe. That split is not a privilege boundary that can
 * widen: the server-side demo checks stand on their own, so a client and
 * server that disagree about demo mode fail closed. The demo management bearer
 * is a public constant and never matches a real-mode server, and a real
 * keychain token never matches a demo server.
 */
export function isDemoFixtureEnabled(): boolean {
  return process.env.CMM_USAGE_DEMO_FIXTURE === "1";
}

export interface ProductionUsageRuntimeOptions {
  configDir?: string;
  databasePath?: string;
  catalog?: UsageIntegrationCatalog;
  credentialResolver?: SecureCredentialResolver;
  service?: UsageServiceOptions;
  /**
   * Current canonical Router catalog truth. Production composition injects the
   * in-process `buildRouterCatalogProjection(...)` of the same Router graph that
   * backs `/v1/cmm/catalog`; Usage never calls that endpoint over HTTP. When it
   * is absent the catalog reports no operational routes rather than inventing
   * them from Usage SQLite.
   */
  routerCatalog?: RouterCatalogSource;
  /**
   * Canonical Router administration authority.
   *
   * The CMM Usage connection/visibility compatibility endpoints delegate to it
   * and never hold operational authority of their own. When it is absent those
   * endpoints fail closed instead of writing a second Router state graph into
   * Usage storage.
   */
  routerAdministration?: RouterAdministrationService;
}

export interface ProductionUsageRuntime {
  config: LoadedUsageRuntimeConfig;
  store: SqliteUsageStore;
  runtime: ConfiguredUsageRuntime;
  presentationCatalog: PresentationCatalogService;
  visibility: VisibilityStore;
  connections: ConnectionManagementService;
  /**
   * One-time legacy visibility migration into the Router authority.
   *
   * Deliberately *not* run automatically. Re-running it after Router has
   * become authoritative would let a stale legacy row override a later Router
   * decision (for example re-hiding a route an operator has since re-enabled),
   * so the migration window is an explicit operation rather than a boot step.
   * Callers invoke it once during the migration window.
   *
   * It is fail-closed: with no Router administration wired (a Usage-only
   * harness, or demo mode, where the real authority is withheld at the
   * composition root) it reports nothing migrated and mutates no Router state.
   * Ambiguous, workspace-scoped, `inherit` and unknown rows are reported rather
   * than guessed, and migration never broadens visibility.
   */
  migrateLegacyVisibility(): Promise<LegacyVisibilityMigrationResult>;
  resolveApiToken(): Promise<string | undefined>;
  resolveManagementApiToken(): Promise<string | undefined>;
  close(): Promise<void>;
}

export function defaultUsageDatabasePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "CMM Routers",
    "Usage",
    "cmm-usage.sqlite3",
  );
}

function demoProductKind(kind: string): ProductKind {
  switch (kind) {
    case "subscription":
      return "subscription";
    case "free_pool":
    case "promo_pool":
    case "enterprise":
    case "local":
      return kind;
    default:
      return "api";
  }
}

/**
 * Synthetic Router truth for the public-safe demo fixture.
 *
 * The demo runtime is a self-contained showcase with no Router process, so the
 * seeded demo fixture rows stand in for the canonical graph. This source is
 * gated to `CMM_USAGE_DEMO_FIXTURE=1` and is never used in production, where
 * composition injects the real canonical Router projection instead.
 */
function demoRouterCatalogSource(store: UsageStore): RouterCatalogSource {
  return {
    async read(): Promise<RouterCatalogProjection> {
      const [providers, products, models, routes] = await Promise.all([
        store.listProviders(),
        store.listProducts(),
        store.listModelIdentities(),
        store.listAccessRoutes(),
      ]);
      const providerIdByProduct = new Map(
        products.map((product) => [product.id, product.providerId] as const),
      );
      const productKindById = new Map(
        products.map((product) => [product.id, product.kind] as const),
      );
      const accountIdByProduct = new Map<string, string>();
      for (const route of routes) {
        if (!accountIdByProduct.has(route.productId)) {
          accountIdByProduct.set(route.productId, route.accountId);
        }
      }
      return {
        providers: providers.map((provider) => ({
          providerId: provider.id,
          displayName: provider.displayName,
        })),
        accounts: [],
        products: products.flatMap((product) => {
          const accountId = accountIdByProduct.get(product.id);
          if (accountId === undefined) return [];
          return [{
            productId: product.id,
            accountId,
            providerId: product.providerId,
            kind: demoProductKind(product.kind),
            label: product.displayName,
          }];
        }),
        connections: [],
        models: models.map((model) => ({
          modelIdentityId: model.id,
          canonicalName: model.canonicalName,
          ...(model.family === undefined ? {} : { family: model.family }),
          aliases: model.aliases,
        })),
        routes: routes.flatMap((route) => {
          if (route.modelIdentityId === undefined) return [];
          return [{
            routeId: route.id,
            modelIdentityId: route.modelIdentityId,
            connectionId: `demo-connection:${route.accountId}`,
            providerId: providerIdByProduct.get(route.productId) ?? route.productId,
            providerModelId: route.providerModelId,
            executionProfile: "default",
            capabilities: { chat: true, tools: true, streaming: true },
            billingClass: productKindById.get(route.productId) ?? "unknown",
            routable: route.status === "available",
            visibility: { visibleOn: ["cmmchat_model_picker", "admin_console"] },
          }];
        }),
      };
    },
  };
}

export async function createProductionUsageRuntime(
  options: ProductionUsageRuntimeOptions = {},
): Promise<ProductionUsageRuntime> {
  const demoFixture = isDemoFixtureEnabled();
  const config = demoFixture ? PUBLIC_SAFE_DEMO_CONFIG : loadUsageRuntimeConfig(options.configDir);
  const store = new SqliteUsageStore(
    demoFixture
      ? ":memory:"
      : options.databasePath ?? config.databasePath ?? defaultUsageDatabasePath(),
  );
  await store.initialize();

  const resolver: SecureCredentialResolver = demoFixture
    ? {
        resolve(reference: string) {
          if (reference === PUBLIC_SAFE_DEMO_CONFIG.apiCredentialRef) return PUBLIC_SAFE_DEMO_READ_TOKEN;
          if (reference === PUBLIC_SAFE_DEMO_CONFIG.managementApiCredentialRef) {
            return PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN;
          }
          return undefined;
        },
      }
    : options.credentialResolver ?? new LocalSecureCredentialResolver();
  const catalog = demoFixture
    ? createPublicSafeDemoIntegrationCatalog()
    : options.catalog ?? createDefaultUsageIntegrationCatalog(resolver);
  const runtime = new ConfiguredUsageRuntime(store, catalog, options.service);
  try {
    await runtime.applyConfig(config);
    if (demoFixture) await seedPublicSafeCatalogFixture(store);
  } catch (error) {
    await store.close();
    throw error;
  }
  const visibility = new VisibilityStore(store);
  const providerDirectory = createDefaultProviderDirectory(config.integrations);
  const routerCatalog = demoFixture
    ? demoRouterCatalogSource(store)
    : options.routerCatalog ?? emptyRouterCatalogSource();
  const presentationCatalog = new PresentationCatalogService(
    routerCatalog,
    store,
    runtime.service.queries,
    providerDirectory,
  );
  // Demo mode must never receive the real Router administration on this
  // compatibility surface. The demo management bearer is a public constant, so
  // a compatibility mutation that reached the real authority would let anyone
  // write real `shared.json` administrative state, the real OS keychain and
  // real provider discovery. Withholding it here makes every compatibility
  // mutation fail closed (503). This is only the compatibility half of the
  // isolation: the canonical `/v1/cmm/catalog/**` administration surface is
  // withheld independently at the composition root (`createProductionServer`),
  // which is where the real authority is wired into HTTP. Real mode delegates
  // to the injected authority exactly as before.
  const connections = new ConnectionManagementService(
    demoFixture ? undefined : options.routerAdministration,
    {
      collectorRefresh: runtime.service,
      routerCatalog,
    },
  );

  return {
    config,
    store,
    runtime,
    presentationCatalog,
    visibility,
    connections,
    migrateLegacyVisibility: async (): Promise<LegacyVisibilityMigrationResult> => {
      // Demo mode never reaches the real Router authority, and a Usage-only
      // composition has none to reach. Both report nothing to migrate rather
      // than promoting legacy rows into invented Router state.
      const administration = demoFixture ? undefined : options.routerAdministration;
      if (administration === undefined) {
        return { migratedRouteIds: [], skippedAmbiguous: [], skippedUnknown: [] };
      }
      return runLegacyVisibilityMigration(
        visibility,
        await routerCatalog.read(),
        administration,
      );
    },
    resolveApiToken: async () => resolver.resolve(config.apiCredentialRef),
    resolveManagementApiToken: async () => resolver.resolve(config.managementApiCredentialRef),
    close: async () => {
      await runtime.service.stop();
      await store.close();
    },
  };
}
