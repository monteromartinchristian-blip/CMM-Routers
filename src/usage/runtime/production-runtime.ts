import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteUsageStore } from "../storage/sqlite-usage-store.js";
import { ConfiguredUsageRuntime, UsageIntegrationCatalog } from "./configured-runtime.js";
import { loadUsageRuntimeConfig, type LoadedUsageRuntimeConfig } from "./config.js";
import { LocalSecureCredentialResolver } from "./credential-resolver.js";
import {
  createDefaultUsageIntegrationCatalog,
  type SecureCredentialResolver,
} from "./integration-catalog.js";
import type { UsageServiceOptions } from "../service/usage-service.js";
import { createDefaultProviderDirectory } from "../presentation/provider-directory.js";
import { PresentationCatalogService } from "../presentation/presentation-catalog-service.js";
import { VisibilityStore } from "../presentation/visibility-store.js";
import { ManagedConfigStore } from "./managed-config-store.js";
import {
  LocalSecureCredentialWriter,
  type CredentialWriter,
} from "./credential-writer.js";
import { ConnectionManagementService } from "../service/connection-management-service.js";
import {
  PUBLIC_SAFE_DEMO_CONFIG,
  PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
  PUBLIC_SAFE_DEMO_READ_TOKEN,
  PublicSafeDemoCredentialWriter,
  PublicSafeDemoManagedConfigStore,
  createPublicSafeDemoIntegrationCatalog,
  seedPublicSafeCatalogFixture,
} from "../demo/public-safe-catalog-fixture.js";

export interface ProductionUsageRuntimeOptions {
  configDir?: string;
  databasePath?: string;
  catalog?: UsageIntegrationCatalog;
  credentialResolver?: SecureCredentialResolver;
  credentialWriter?: CredentialWriter;
  managedConfigStore?: ManagedConfigStore;
  service?: UsageServiceOptions;
}

export interface ProductionUsageRuntime {
  config: LoadedUsageRuntimeConfig;
  store: SqliteUsageStore;
  runtime: ConfiguredUsageRuntime;
  presentationCatalog: PresentationCatalogService;
  visibility: VisibilityStore;
  connections: ConnectionManagementService;
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

export async function createProductionUsageRuntime(
  options: ProductionUsageRuntimeOptions = {},
): Promise<ProductionUsageRuntime> {
  const demoFixture = process.env.CMM_USAGE_DEMO_FIXTURE === "1";
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
  const presentationCatalog = new PresentationCatalogService(
    store,
    runtime.service.queries,
    createDefaultProviderDirectory(config.integrations),
    visibility,
  );
  const managedConfigStore = demoFixture
    ? new PublicSafeDemoManagedConfigStore(config)
    : options.managedConfigStore ?? new ManagedConfigStore(options.configDir);
  const credentialWriter = demoFixture
    ? new PublicSafeDemoCredentialWriter()
    : options.credentialWriter ?? new LocalSecureCredentialWriter();
  const connections = new ConnectionManagementService(
    managedConfigStore,
    credentialWriter,
    runtime,
    visibility,
  );

  return {
    config,
    store,
    runtime,
    presentationCatalog,
    visibility,
    connections,
    resolveApiToken: async () => resolver.resolve(config.apiCredentialRef),
    resolveManagementApiToken: async () => resolver.resolve(config.managementApiCredentialRef),
    close: async () => {
      await runtime.service.stop();
      await store.close();
    },
  };
}
