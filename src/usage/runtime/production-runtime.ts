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

export interface ProductionUsageRuntimeOptions {
  configDir?: string;
  databasePath?: string;
  catalog?: UsageIntegrationCatalog;
  credentialResolver?: SecureCredentialResolver;
  service?: UsageServiceOptions;
}

export interface ProductionUsageRuntime {
  config: LoadedUsageRuntimeConfig;
  store: SqliteUsageStore;
  runtime: ConfiguredUsageRuntime;
  presentationCatalog: PresentationCatalogService;
  visibility: VisibilityStore;
  resolveApiToken(): Promise<string | undefined>;
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
  const config = loadUsageRuntimeConfig(options.configDir);
  const store = new SqliteUsageStore(
    options.databasePath ?? config.databasePath ?? defaultUsageDatabasePath(),
  );
  await store.initialize();

  const resolver = options.credentialResolver ?? new LocalSecureCredentialResolver();
  const catalog = options.catalog ?? createDefaultUsageIntegrationCatalog(resolver);
  const runtime = new ConfiguredUsageRuntime(store, catalog, options.service);
  try {
    await runtime.applyConfig(config);
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

  return {
    config,
    store,
    runtime,
    presentationCatalog,
    visibility,
    resolveApiToken: async () => resolver.resolve(config.apiCredentialRef),
    close: async () => {
      await runtime.service.stop();
      await store.close();
    },
  };
}
