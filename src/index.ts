import { ensureSharedConfigFromExample, loadConfig, type RouterConfig } from "./config/load-config.js";
import {
  type ProviderCatalogConfig,
  WAVE_PROVIDER_IDS,
  waveProviderConfig,
  type WaveProviderId,
} from "./config/schema.js";
import { ProviderRegistry } from "./registry/provider-registry.js";
import { buildServer } from "./http/server.js";
import { UsageStore } from "./observability/usage-store.js";
import { requireSpendAcknowledgement } from "./providers/command-code/spend-guard.js";
import { CodexAdapter } from "./providers/codex/adapter.js";
import { ClaudeAdapter } from "./providers/claude/adapter.js";
import { AntigravityAdapter } from "./providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "./providers/command-code/adapter.js";
import { CavotiAdapter } from "./providers/cavoti/adapter.js";
import {
  defaultCavotiAckPath,
  requireCavotiSpendAcknowledgement,
} from "./providers/cavoti/spend-guard.js";
import {
  assertProviderWaveInventory,
  canonicalModelIdentityName,
  GENERIC_WAVE_MANIFESTS,
  providerDefinitions,
  providerWaveManifest,
  resolveEffectiveActivation,
  SUBSCRIPTION_BRIDGE_IDS,
  subscriptionBridgeDefinitions,
} from "./providers/manifests.js";
import {
  OpenAiCompatibleAdapter,
  type ProviderFetchFn,
} from "./providers/openai-compatible/adapter.js";
import {
  isActivatedModel,
  resolveProviderBaseUrl,
  type ProviderManifest,
} from "./providers/manifest.js";
import { DeferredToolBroker } from "./core/deferred-tool-broker.js";
import type { UsageService as CmmUsageService } from "./usage/service/usage-service.js";
import { createProductionUsageRuntime } from "./usage/runtime/production-runtime.js";
import type { PresentationCatalogService } from "./usage/presentation/presentation-catalog-service.js";
import type { VisibilityStore } from "./usage/presentation/visibility-store.js";
import type { ConnectionManagementService } from "./usage/service/connection-management-service.js";
import { ProviderDirectory } from "./catalog/provider-directory.js";
import { buildRouterCatalogProjection, type RouterCatalogProjectionInput } from "./catalog/projection.js";
import { CredentialBindingStore } from "./catalog/credential-bindings.js";
import { ProviderConnectionService } from "./catalog/provider-connections.js";
import { ModelIdentityStore } from "./catalog/model-identities.js";
import { RouteCatalog } from "./catalog/route-catalog.js";
import { RouteVisibilityPolicy } from "./catalog/route-visibility-policy.js";
import { RouterAdministrationService } from "./catalog/router-administration-service.js";
import { RouterAdminConfigStore } from "./catalog/router-admin-config-store.js";
import { LocalSecureCredentialWriter } from "./catalog/local-secure-credential-writer.js";
import {
  CatalogReconciler,
  type CatalogRoutePolicy,
} from "./catalog/catalog-reconciler.js";
import {
  CatalogRuntimeBridge,
  supportsExactResolvedRouteExecution,
} from "./catalog/runtime-bridge.js";
import {
  buildAccountId,
  buildConnectionId,
  buildModelIdentityId,
  buildProductId,
  buildRouteId,
} from "./catalog/ids.js";
import type {
  ResolvedSecret,
  SecureCredentialResolver,
} from "./catalog/secure-credential-resolver.js";
import type {
  Account,
  ProviderProduct,
} from "./catalog/types.js";
import type { ProviderId } from "./core/model.js";

export interface ProductionComposition {
  config: RouterConfig;
  registry: ProviderRegistry;
  usageStore: UsageStore;
  providerDirectory: ProviderDirectory;
  credentialBindings: CredentialBindingStore;
  providerConnections: ProviderConnectionService;
  modelIdentities: ModelIdentityStore;
  routeCatalog: RouteCatalog;
  routeVisibilityPolicy: RouteVisibilityPolicy;
  catalogReconciler: CatalogReconciler;
  runtimeBridge: CatalogRuntimeBridge;
  /**
   * Router-owned privileged administration authority. Built from the same
   * canonical directory/connections/bindings/catalog/reconciler graph used by
   * execution, so privileged HTTP mutation and inference share one Router
   * state graph.
   */
  routerAdministration: RouterAdministrationService;
  accounts: Account[];
  products: ProviderProduct[];
  registeredProviders: string[];
  skippedProviders: Array<{ id: string; reason: string }>;
  /**
   * Single Router-owned bounded pending-tool broker shared by every provider
   * adapter that needs cross-request Qoder tool correlation. Injected
   * explicitly; never a per-adapter instance in production.
   */
  toolBroker: DeferredToolBroker;
}

export interface ProductionCompositionOptions {
  /**
   * Injected HTTP transport for the OpenAI-compatible wave. Deterministic
   * tests must pass a fixture transport so no live provider call happens;
   * production omits it and the adapters use the real `fetch`.
   */
  fetchFn?: ProviderFetchFn | undefined;
  /**
   * Lower-level deterministic seams for dedicated adapters. Production still
   * constructs the real adapter classes, so callers cannot replace the
   * exact-route validation boundary with an arbitrary look-alike adapter.
   */
  dedicatedAdapterDependencies?: {
    chatgptTransportFactory?: NonNullable<
      ConstructorParameters<typeof CodexAdapter>[0]
    >["transportFactory"];
    claudeQueryFn?: NonNullable<
      ConstructorParameters<typeof ClaudeAdapter>[0]
    >["queryFn"];
    googleInferenceRunner?: ConstructorParameters<typeof AntigravityAdapter>[0];
    googleModelsRunner?: ConstructorParameters<typeof AntigravityAdapter>[1];
    commandCodeClient?: NonNullable<
      ConstructorParameters<typeof CommandCodeAdapter>[0]
    >["client"];
    cavotiClient?: NonNullable<
      ConstructorParameters<typeof CavotiAdapter>[0]
    >["client"];
  };
  /** Minimum interval between live catalog reconciliations. */
  catalogReconcileIntervalMs?: number | undefined;
  /**
   * Config directory backing Router administrative persistence. Defaults to
   * `CMM_CONFIG_DIR` (or the process config directory) so privileged
   * administration writes land beside the configuration it was loaded from.
   */
  configDir?: string | undefined;
}

function isWaveProviderId(id: string): id is WaveProviderId {
  return (WAVE_PROVIDER_IDS as readonly string[]).includes(id);
}

function providerCatalogConfig(
  config: RouterConfig,
  providerId: string,
): ProviderCatalogConfig | undefined {
  const providers = config.providers as unknown as Record<
    string,
    { catalog?: ProviderCatalogConfig } | undefined
  >;
  return providers[providerId]?.catalog;
}

/**
 * Registers one approved-wave provider from its manifest plus its config entry.
 * Fails closed at every step: an unknown base URL, an absent credential or an
 * unsupported api style skips the provider with a reason instead of guessing.
 */
function registerWaveProvider(
  manifest: ProviderManifest,
  config: RouterConfig,
  options: ProductionCompositionOptions,
  registeredProviders: string[],
  skippedProviders: Array<{ id: string; reason: string }>,
): OpenAiCompatibleAdapter | null {
  if (!isWaveProviderId(manifest.id)) {
    throw new Error(`Provider ${manifest.id} is not a wave provider id`);
  }
  const configured = waveProviderConfig(config.providers, manifest.id);
  if (configured === undefined) {
    skippedProviders.push({ id: manifest.id, reason: "not present in config" });
    return null;
  }
  if (!configured.enabled) {
    skippedProviders.push({ id: manifest.id, reason: "disabled in config" });
    return null;
  }
  const baseUrl = resolveProviderBaseUrl(manifest, configured.baseUrl);
  if (baseUrl === null) {
    skippedProviders.push({
      id: manifest.id,
      reason:
        "base URL is not deterministically known for this account/region; " +
        `set providers.${manifest.id}.baseUrl in config`,
    });
    return null;
  }
  if (!process.env[configured.secretEnv]) {
    skippedProviders.push({
      id: manifest.id,
      reason: `secret env ${configured.secretEnv} absent`,
    });
    return null;
  }
  // Config activation is an override; an absent one inherits the manifest
  // scope, so a manifest-level `none` is never silently widened.
  const activation = resolveEffectiveActivation(manifest, configured.activation);
  const adapter = new OpenAiCompatibleAdapter({
    manifest,
    baseUrl,
    secretEnv: configured.secretEnv,
    discoveryPath: configured.discoveryPath,
    activation,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
  registeredProviders.push(adapter.id);
  return adapter;
}

function isCommandCodeAckValid(ackPath?: string): boolean {
  try {
    requireSpendAcknowledgement(ackPath);
    return true;
  } catch {
    return false;
  }
}

function isCavotiAckValid(ackPath: string): boolean {
  try {
    requireCavotiSpendAcknowledgement(ackPath);
    return true;
  } catch {
    return false;
  }
}

const RUNTIME_AUTH_PREFIX = "runtime-auth://";
const ENV_SECRET_PREFIX = "env://";

class ProductionCredentialResolver implements SecureCredentialResolver {
  constructor(private readonly registry: ProviderRegistry) {}

  async resolve(secretRef: string): Promise<ResolvedSecret> {
    if (secretRef.startsWith(ENV_SECRET_PREFIX)) {
      const envName = secretRef.slice(ENV_SECRET_PREFIX.length);
      if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
        throw new Error("Invalid environment credential reference");
      }
      const value = process.env[envName]?.trim();
      if (!value) throw new Error("Environment credential is unavailable");
      return { value };
    }

    if (secretRef.startsWith(RUNTIME_AUTH_PREFIX)) {
      const providerId = secretRef.slice(RUNTIME_AUTH_PREFIX.length);
      if (!providerId || this.registry.getAdapter(providerId) === undefined) {
        throw new Error("Runtime-backed authorization is unavailable");
      }
      // Subscription adapters keep their native credential/profile material in
      // their existing secure runtime. This marker authorizes the exact catalog
      // connection without copying that material into shared-core state.
      return { value: `authorized:${providerId}` };
    }

    throw new Error("Unsupported credential reference");
  }
}

function bridgeProfileRef(providerId: string, config: RouterConfig): string | undefined {
  if (providerId === "chatgpt") return resolveChatgptCodexHome(config);
  if (providerId === "claude") return resolveClaudeProfileDir(config);
  if (providerId === "google") return resolveGoogleAgyPath(config);
  return undefined;
}

function connectionFacts(
  providerId: string,
  config: RouterConfig,
): {
  connectionKind: string;
  billingClass: string;
  secretRef: string;
  endpointRef?: string;
  profileRef?: string;
} {
  if ((SUBSCRIPTION_BRIDGE_IDS as readonly string[]).includes(providerId)) {
    const definition = subscriptionBridgeDefinitions().find(
      (candidate) => candidate.providerId === providerId,
    );
    if (definition === undefined) throw new Error(`Unknown subscription bridge: ${providerId}`);
    const profileRef = bridgeProfileRef(providerId, config);
    return {
      connectionKind: definition.supportedConnectionKinds[0]!,
      billingClass: "subscription",
      secretRef: `${RUNTIME_AUTH_PREFIX}${providerId}`,
      ...(profileRef !== undefined ? { profileRef } : {}),
    };
  }

  const manifest = providerWaveManifest(providerId as ProviderId);
  let endpointRef = manifest.baseUrl ?? undefined;
  let secretEnv = manifest.auth.secretEnv;
  if (isWaveProviderId(providerId)) {
    const configured = waveProviderConfig(config.providers, providerId);
    endpointRef = resolveProviderBaseUrl(manifest, configured?.baseUrl) ?? undefined;
    secretEnv = configured?.secretEnv ?? secretEnv;
  } else if (providerId === "command-code") {
    endpointRef = config.providers["command-code"].baseUrl;
    secretEnv = config.providers["command-code"].secretEnv;
  } else if (providerId === "cavoti") {
    endpointRef = config.providers.cavoti.baseUrl;
    secretEnv = config.providers.cavoti.secretEnv;
  }
  return {
    connectionKind: manifest.apiStyles[0]!,
    billingClass: manifest.billingClass,
    secretRef: `${ENV_SECRET_PREFIX}${secretEnv}`,
    ...(endpointRef !== undefined ? { endpointRef } : {}),
  };
}

function stableOpaqueRef(value: string): string {
  return encodeURIComponent(value).replace(/'/gu, "%27");
}

function routeIsActivated(providerId: string, modelId: string, config: RouterConfig): boolean {
  if ((SUBSCRIPTION_BRIDGE_IDS as readonly string[]).includes(providerId)) return true;
  const manifest = providerWaveManifest(providerId as ProviderId);
  const configured = isWaveProviderId(providerId)
    ? waveProviderConfig(config.providers, providerId)
    : undefined;
  return isActivatedModel(
    {
      ...manifest,
      activation: resolveEffectiveActivation(manifest, configured?.activation),
    },
    modelId,
  );
}

function composeSharedCatalog(
  config: RouterConfig,
  registry: ProviderRegistry,
  registeredProviders: readonly string[],
  options: ProductionCompositionOptions,
  configDir: string | undefined,
): Pick<
  ProductionComposition,
  | "providerDirectory"
  | "credentialBindings"
  | "providerConnections"
  | "modelIdentities"
  | "routeCatalog"
  | "routeVisibilityPolicy"
  | "catalogReconciler"
  | "runtimeBridge"
  | "routerAdministration"
  | "accounts"
  | "products"
> {
  const providerDirectory = new ProviderDirectory();
  for (const definition of [
    ...subscriptionBridgeDefinitions(),
    ...providerDefinitions(),
  ]) {
    providerDirectory.register(definition);
  }

  const credentialBindings = new CredentialBindingStore();
  const credentialResolver = new ProductionCredentialResolver(registry);
  const administrativeDiscovery = new Map(
    registeredProviders.map((providerId) => [
      providerId,
      async () => registry.getDiscoveredModels(providerId),
    ] as const),
  );
  const providerConnections = new ProviderConnectionService({
    directory: providerDirectory,
    credentialBindings,
    credentialResolver,
    administrativeDiscovery,
  });
  const modelIdentities = new ModelIdentityStore();
  const routeCatalog = new RouteCatalog({
    connections: providerConnections,
    modelIdentities,
  });
  const routeVisibilityPolicy = new RouteVisibilityPolicy(
    config.routeVisibility,
    config.routeVisibilityMigrationInput,
  );
  const accounts: Account[] = [];
  const products: ProviderProduct[] = [];

  for (const providerId of registeredProviders) {
    const definition = providerDirectory.get(providerId);
    if (definition === undefined) continue;
    const facts = connectionFacts(providerId, config);
    const catalog = providerCatalogConfig(config, providerId);

    if (catalog === undefined) {
      // Unknown account identity is intentionally not materialized as a fake
      // Account/Product. The connection remains executable, while the product
      // projection exposes its identity as unresolved for Usage/admin clients.
      const connectionId = buildConnectionId({
        providerId,
        connectionKind: facts.connectionKind,
        ...(facts.profileRef !== undefined
          ? { profileRef: stableOpaqueRef(facts.profileRef) }
          : {}),
        ...(facts.endpointRef !== undefined
          ? { endpointRef: stableOpaqueRef(facts.endpointRef) }
          : {}),
      });
      const bindingId = `execution:${connectionId}`;
      credentialBindings.addExecution({
        bindingId,
        providerId,
        secretRef: facts.secretRef,
        purpose: "execution",
        enabled: true,
      });
      providerConnections.add({
        connectionId,
        providerId,
        connectionKind: facts.connectionKind,
        executionCredentialBindingId: bindingId,
        ...(facts.profileRef !== undefined ? { profileRef: facts.profileRef } : {}),
        ...(facts.endpointRef !== undefined ? { endpointRef: facts.endpointRef } : {}),
        status: "configured",
      });
      continue;
    }

    const accountIdByRef = new Map<string, string>();
    for (const configuredAccount of catalog.accounts) {
      const accountId =
        configuredAccount.identityStatus === "resolved"
          ? buildAccountId({
              providerId,
              identityStatus: "resolved",
              externalAccountRef: configuredAccount.externalAccountRef,
            })
          : buildAccountId({
              providerId,
              identityStatus: "unresolved",
              accountRef: configuredAccount.ref,
            });
      accountIdByRef.set(configuredAccount.ref, accountId);
      accounts.push({
        accountId,
        providerId,
        label: configuredAccount.label,
        identityStatus: configuredAccount.identityStatus,
        ...(configuredAccount.identityStatus === "resolved"
          ? { externalAccountRef: configuredAccount.externalAccountRef }
          : {}),
      });
    }

    const productByRef = new Map<
      string,
      { productId: string; accountId: string }
    >();
    for (const configuredProduct of catalog.products) {
      const accountId = accountIdByRef.get(configuredProduct.accountRef);
      if (accountId === undefined) {
        throw new Error("Provider catalog product references an unknown account");
      }
      const productId = buildProductId({
        providerId,
        accountId,
        productRef: configuredProduct.ref,
      });
      productByRef.set(configuredProduct.ref, { productId, accountId });
      products.push({
        productId,
        accountId,
        providerId,
        kind: configuredProduct.kind,
        label: configuredProduct.label,
      });
    }

    for (const configuredConnection of catalog.connections) {
      const product = productByRef.get(configuredConnection.productRef);
      if (product === undefined) {
        throw new Error("Provider catalog connection references an unknown product");
      }
      const connectionId = buildConnectionId({
        providerId,
        connectionRef: configuredConnection.ref,
        accountId: product.accountId,
        productId: product.productId,
        connectionKind: facts.connectionKind,
        ...(facts.profileRef !== undefined
          ? { profileRef: stableOpaqueRef(facts.profileRef) }
          : {}),
        ...(facts.endpointRef !== undefined
          ? { endpointRef: stableOpaqueRef(facts.endpointRef) }
          : {}),
      });

      if (configuredConnection.runtime === "primary") {
        const bindingId = `execution:${connectionId}`;
        credentialBindings.addExecution({
          bindingId,
          providerId,
          accountId: product.accountId,
          productId: product.productId,
          secretRef: facts.secretRef,
          purpose: "execution",
          enabled: true,
        });
        providerConnections.add({
          connectionId,
          providerId,
          accountId: product.accountId,
          productId: product.productId,
          connectionKind: facts.connectionKind,
          executionCredentialBindingId: bindingId,
          ...(facts.profileRef !== undefined ? { profileRef: facts.profileRef } : {}),
          ...(facts.endpointRef !== undefined ? { endpointRef: facts.endpointRef } : {}),
          status: "configured",
        });
      } else {
        providerConnections.add({
          connectionId,
          providerId,
          accountId: product.accountId,
          productId: product.productId,
          connectionKind: facts.connectionKind,
          ...(facts.profileRef !== undefined ? { profileRef: facts.profileRef } : {}),
          ...(facts.endpointRef !== undefined ? { endpointRef: facts.endpointRef } : {}),
          status: "disabled",
        });
      }
    }
  }

  const routePolicy: CatalogRoutePolicy = (connection, model) => {
    const adapter = registry.getAdapter(connection.providerId);
    const exactRouteExecutable =
      adapter !== undefined && supportsExactResolvedRouteExecution(adapter);
    const tools = model.capabilities?.tools === true;
    return {
      canonicalName: canonicalModelIdentityName(
        connection.providerId as ProviderId,
        model.providerModelId,
      ),
      executionProfile: "default",
      capabilities: {
        chat: model.capabilities?.chat !== false,
        tools,
        streaming: true,
      },
      billingClass: connectionFacts(connection.providerId, config).billingClass,
      routable:
        exactRouteExecutable &&
        routeIsActivated(connection.providerId, model.providerModelId, config),
      visibility: routeVisibilityPolicy.resolve({
        providerId: connection.providerId,
        providerModelId: model.providerModelId,
        toolCapable: tools,
        exactRouteExecutable,
      }),
    };
  };

  const catalogReconciler = new CatalogReconciler({
    connections: providerConnections,
    modelIdentities,
    routeCatalog,
    routePolicy,
    ...(options.catalogReconcileIntervalMs !== undefined
      ? { minRefreshIntervalMs: options.catalogReconcileIntervalMs }
      : {}),
  });

  const runtimeBridge = new CatalogRuntimeBridge({
    catalog: routeCatalog,
    connections: providerConnections,
    registry,
    beforeResolveRoute: async (routeId) => {
      const route = routeCatalog.get(routeId);
      if (route !== undefined) {
        await catalogReconciler.reconcileConnection(route.connectionId);
      }
    },
  });

  // Privileged administration is constructed from the exact canonical graph
  // above. It is the only Router mutation authority: no second directory,
  // connection, binding or route state graph is created for administration.
  const routerAdministration = new RouterAdministrationService({
    directory: providerDirectory,
    connections: providerConnections,
    credentialBindings,
    routeCatalog,
    catalogReconciler,
    configStore: new RouterAdminConfigStore(configDir),
    credentialWriter: new LocalSecureCredentialWriter(),
    routeVisibilityPolicy,
  });

  return {
    providerDirectory,
    credentialBindings,
    providerConnections,
    modelIdentities,
    routeCatalog,
    routeVisibilityPolicy,
    catalogReconciler,
    runtimeBridge,
    routerAdministration,
    accounts,
    products,
  };
}

export function resolveChatgptCodexHome(config: RouterConfig): string | undefined {
  return config.providers.chatgpt.codexHome;
}

export function resolveClaudeProfileDir(config: RouterConfig): string | undefined {
  return config.providers.claude.profileDir;
}

export function resolveGoogleAgyPath(config: RouterConfig): string | undefined {
  return config.providers.google.agyPath;
}

/**
 * Narrowly scoped test-provider injection for the compiled-process E2E.
 * Active ONLY when CMM_TEST_PROVIDER=scripted is set explicitly; normal
 * production never sets it and always uses real subscription adapters.
 * The scripted double serves one canned model with no network, no quota,
 * and no secrets.
 */
export function isTestProviderEnabled(): boolean {
  return process.env.CMM_TEST_PROVIDER === "scripted";
}

export async function createProductionRegistry(
  config?: RouterConfig,
  options: ProductionCompositionOptions = {},
): Promise<ProductionComposition> {
  // Fresh-clone bootstrap: a clean checkout ships only
  // config/shared.example.json. Install it as shared.json (never
  // overwriting, never secrets) before parsing. CMM_CONFIG_DIR isolates
  // the compiled-process E2E onto a temp config dir.
  const configDir = options.configDir ?? process.env.CMM_CONFIG_DIR;
  if (!config) ensureSharedConfigFromExample(configDir);
  const resolved = config ?? loadConfig(configDir);
  // Inventory invariant before anything is registered: unique route ids and
  // unique credential namespaces across the approved wave.
  assertProviderWaveInventory();
  const registry = new ProviderRegistry();
  const usageStore = new UsageStore();
  const toolBroker = new DeferredToolBroker();
  const registeredProviders: string[] = [];
  const skippedProviders: Array<{ id: string; reason: string }> = [];

  if (isTestProviderEnabled()) {
    const { ScriptedTestAdapter } = await import("./testing/scripted-adapter.js");
    const adapter = new ScriptedTestAdapter();
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
    await registry.refresh();
    return {
      config: resolved,
      registry,
      usageStore,
      registeredProviders,
      skippedProviders,
      toolBroker,
      ...(await (async () => {
        const shared = composeSharedCatalog(
          resolved,
          registry,
          registeredProviders,
          options,
          configDir,
        );
        await shared.catalogReconciler.reconcileAll({ force: true });
        return shared;
      })()),
    };
  }

  if (resolved.providers.chatgpt.enabled) {
    const codexHome = resolveChatgptCodexHome(resolved);
    const adapter = new CodexAdapter({
      ...(codexHome ? { codexHome } : {}),
      broker: toolBroker,
      ...(options.dedicatedAdapterDependencies?.chatgptTransportFactory !== undefined
        ? {
            transportFactory:
              options.dedicatedAdapterDependencies.chatgptTransportFactory,
          }
        : {}),
    });
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
  } else {
    skippedProviders.push({ id: "chatgpt", reason: "disabled in config" });
  }

  if (resolved.providers.claude.enabled) {
    // Explicit runtime injection: the adapter builds its isolated SDK env
    // from this value per request. No global process.env mutation — the
    // configured profile is effective even though sdk-client was imported
    // long before this factory runs. The shared broker backs the
    // cross-request Qoder tool correlation held across the HTTP split.
    const profileDir = resolveClaudeProfileDir(resolved);
    const adapter = new ClaudeAdapter({
      ...(profileDir ? { profileDir } : {}),
      broker: toolBroker,
      ...(options.dedicatedAdapterDependencies?.claudeQueryFn !== undefined
        ? { queryFn: options.dedicatedAdapterDependencies.claudeQueryFn }
        : {}),
    });
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
  } else {
    skippedProviders.push({ id: "claude", reason: "disabled in config" });
  }

  if (resolved.providers.google.enabled) {
    const agyPath = resolveGoogleAgyPath(resolved);
    const adapter = new AntigravityAdapter(
      options.dedicatedAdapterDependencies?.googleInferenceRunner,
      options.dedicatedAdapterDependencies?.googleModelsRunner,
      {
        ...(agyPath ? { agyPath } : {}),
        broker: toolBroker,
      },
    );
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
  } else {
    skippedProviders.push({ id: "google", reason: "disabled in config" });
  }

  if (resolved.providers["command-code"].enabled) {
    const configuredCommandAckPath = process.env.CMM_COMMAND_CODE_ACK_PATH?.trim();
    const commandAckPath =
      configuredCommandAckPath && configuredCommandAckPath.length > 0
        ? configuredCommandAckPath
        : undefined;
    // Never instantiate the spend-guarded provider without its ack.
    if (!isCommandCodeAckValid(commandAckPath)) {
      skippedProviders.push({ id: "command-code", reason: "spend acknowledgement missing or invalid" });
    } else if (!process.env[resolved.providers["command-code"].secretEnv]) {
      skippedProviders.push({
        id: "command-code",
        reason: `secret env ${resolved.providers["command-code"].secretEnv} absent`,
      });
    } else {
      const adapter = new CommandCodeAdapter({
        baseUrl: resolved.providers["command-code"].baseUrl,
        secretEnv: resolved.providers["command-code"].secretEnv,
        ...(commandAckPath !== undefined ? { ackPath: commandAckPath } : {}),
        ...(options.dedicatedAdapterDependencies?.commandCodeClient !== undefined
          ? { client: options.dedicatedAdapterDependencies.commandCodeClient }
          : {}),
      });
      await registry.register(adapter);
      registeredProviders.push(adapter.id);
    }
  } else {
    skippedProviders.push({ id: "command-code", reason: "disabled in config" });
  }

  if (resolved.providers.cavoti.enabled) {
    const cavoti = resolved.providers.cavoti;
    const configuredAckPath = process.env.CMM_CAVOTI_ACK_PATH?.trim();
    const ackPath =
      configuredAckPath && configuredAckPath.length > 0
        ? configuredAckPath
        : defaultCavotiAckPath();

    if (!isCavotiAckValid(ackPath)) {
      skippedProviders.push({
        id: "cavoti",
        reason: "PAYG spend acknowledgement missing or invalid",
      });
    } else {
      const secret = process.env[cavoti.secretEnv]?.trim();
      if (!secret) {
        skippedProviders.push({
          id: "cavoti",
          reason: `secret env ${cavoti.secretEnv} absent`,
        });
      } else {
        const adapter = new CavotiAdapter({
          baseUrl: cavoti.baseUrl,
          secretEnv: cavoti.secretEnv,
          ackPath,
          ...(options.dedicatedAdapterDependencies?.cavotiClient !== undefined
            ? { client: options.dedicatedAdapterDependencies.cavotiClient }
            : {}),
        });
        await registry.register(adapter);
        registeredProviders.push(adapter.id);
      }
    }
  } else {
    skippedProviders.push({ id: "cavoti", reason: "disabled in config" });
  }

  // Approved provider wave: one generic OpenAI-compatible adapter per manifest.
  for (const manifest of GENERIC_WAVE_MANIFESTS) {
    const adapter = registerWaveProvider(
      manifest,
      resolved,
      options,
      registeredProviders,
      skippedProviders,
    );
    if (adapter !== null) await registry.register(adapter);
  }

  await registry.refresh();

  const sharedCatalog = composeSharedCatalog(
    resolved,
    registry,
    registeredProviders,
    options,
    configDir,
  );
  await sharedCatalog.catalogReconciler.reconcileAll({ force: true });

  return {
    config: resolved,
    registry,
    usageStore,
    registeredProviders,
    skippedProviders,
    toolBroker,
    ...sharedCatalog,
  };
}

export interface ProductionUsageServerBinding {
  service: CmmUsageService;
  token: string;
  catalog?: PresentationCatalogService;
  visibility?: VisibilityStore;
  managementToken?: string;
  connections?: ConnectionManagementService;
}

/**
 * The one canonical Router graph projection input.
 *
 * Both the privileged `/v1/cmm/catalog` read and the CMM Usage catalog read
 * this exact graph, so Usage never builds a second Router state graph and never
 * has to call its own HTTP endpoint to learn Router truth.
 */
function routerCatalogProjectionInput(
  composition: ProductionComposition,
): RouterCatalogProjectionInput {
  return {
    directory: composition.providerDirectory,
    accounts: composition.accounts,
    products: composition.products,
    connections: composition.providerConnections,
    modelIdentities: composition.modelIdentities,
    routeCatalog: composition.routeCatalog,
  };
}

export function createProductionServer(
  composition: ProductionComposition,
  bearerSecret: string,
  qoderSecret?: string,
  usage?: ProductionUsageServerBinding,
) {
  return buildServer({
    host: composition.config.host,
    port: composition.config.port,
    bearerSecret,
    ...(qoderSecret !== undefined ? { qoderToken: qoderSecret } : {}),
    registry: composition.registry,
    usageStore: composition.usageStore,
    ...(usage === undefined
      ? {}
      : {
          cmmUsageService: usage.service,
          usageToken: usage.token,
          ...(usage.catalog === undefined ? {} : { cmmUsageCatalog: usage.catalog }),
          ...(usage.visibility === undefined ? {} : { cmmUsageVisibility: usage.visibility }),
          ...(usage.managementToken === undefined ? {} : { usageManagementToken: usage.managementToken }),
          ...(usage.connections === undefined ? {} : { cmmUsageConnections: usage.connections }),
        }),
    runtimeBridge: composition.runtimeBridge,
    routerAdministration: composition.routerAdministration,
    catalogProjectionInput: routerCatalogProjectionInput(composition),
    beforeCatalogRead: async () => {
      await composition.catalogReconciler.reconcileAll();
    },
  });
}

async function main() {
  const composition = await createProductionRegistry();
  const { config, registry, usageStore, registeredProviders, skippedProviders } = composition;
  const cmmUsage = await createProductionUsageRuntime({
    ...(process.env.CMM_CONFIG_DIR === undefined ? {} : { configDir: process.env.CMM_CONFIG_DIR }),
    // In-process Router truth: the same canonical graph that backs
    // `/v1/cmm/catalog`, read directly instead of over HTTP.
    routerCatalog: {
      read: () => buildRouterCatalogProjection(routerCatalogProjectionInput(composition)),
    },
  });
  cmmUsage.runtime.service.start();
  const usageToken = await cmmUsage.resolveApiToken();
  const usageManagementToken = await cmmUsage.resolveManagementApiToken();

  console.log(`Starting CMM Routers on ${config.host}:${config.port}`);
  console.log(`Machine ID: ${config.machineId}`);
  console.log(`Registered providers: ${registeredProviders.join(", ") || "(none)"}`);
  for (const skipped of skippedProviders) {
    console.log(`Skipped provider ${skipped.id}: ${skipped.reason}`);
  }
  console.log(
    `CMM Usage integrations: ${cmmUsage.runtime.adapters.list().map(({ id }) => id).join(", ") || "(none)"}`,
  );
  if (usageToken === undefined) {
    console.warn(
      `CMM Usage API disabled: no credential resolved from ${cmmUsage.config.apiCredentialRef}`,
    );
  }
  if (usageManagementToken === undefined) {
    console.warn(
      `CMM Usage connection management disabled: no credential resolved from ${cmmUsage.config.managementApiCredentialRef}`,
    );
  }

  const bearerSecret = process.env[config.bearerSecretEnv];
  if (!bearerSecret) {
    console.error(
      `Error: Bearer secret environment variable ${config.bearerSecretEnv} is not set`,
    );
    process.exit(1);
  }

  // Optional Qoder consumer token. When unset there is no Qoder consumer and
  // every authenticated client is CMMChat (permanently CHAT_ONLY).
  const qoderSecret = process.env.CMM_QODER_TOKEN;

  const server = createProductionServer(
    composition,
    bearerSecret,
    qoderSecret,
    usageToken === undefined
      ? undefined
      : {
          service: cmmUsage.runtime.service,
          token: usageToken,
          catalog: cmmUsage.presentationCatalog,
          visibility: cmmUsage.visibility,
          ...(usageManagementToken === undefined
            ? {}
            : {
                managementToken: usageManagementToken,
                connections: cmmUsage.connections,
              }),
        },
  );

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      await cmmUsage.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await server.listen({ host: config.host, port: config.port });
    console.log(`Server listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
