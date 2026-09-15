import { ensureSharedConfigFromExample, loadConfig, type RouterConfig } from "./config/load-config.js";
import {
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
import { ProviderDirectory } from "./catalog/provider-directory.js";
import { CredentialBindingStore } from "./catalog/credential-bindings.js";
import { ProviderConnectionService } from "./catalog/provider-connections.js";
import { ModelIdentityStore } from "./catalog/model-identities.js";
import { RouteCatalog } from "./catalog/route-catalog.js";
import { CatalogRuntimeBridge } from "./catalog/runtime-bridge.js";
import {
  buildConnectionId,
  buildModelIdentityId,
  buildRouteId,
} from "./catalog/ids.js";
import type {
  ResolvedSecret,
  SecureCredentialResolver,
} from "./catalog/secure-credential-resolver.js";
import type {
  Account,
  ProductKind,
  ProviderConnection,
  ProviderProduct,
  RouteCapabilities,
} from "./catalog/types.js";
import type { DiscoveredModel, ProviderId } from "./core/model.js";

export interface ProductionComposition {
  config: RouterConfig;
  registry: ProviderRegistry;
  usageStore: UsageStore;
  providerDirectory: ProviderDirectory;
  credentialBindings: CredentialBindingStore;
  providerConnections: ProviderConnectionService;
  modelIdentities: ModelIdentityStore;
  routeCatalog: RouteCatalog;
  runtimeBridge: CatalogRuntimeBridge;
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
}

function isWaveProviderId(id: string): id is WaveProviderId {
  return (WAVE_PROVIDER_IDS as readonly string[]).includes(id);
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

function isCommandCodeAckValid(): boolean {
  try {
    requireSpendAcknowledgement();
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

function productKindForBillingClass(billingClass: string): ProductKind {
  if (billingClass === "subscription") return "subscription";
  if (billingClass === "local") return "local";
  return "api";
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

function modelCapabilities(model: DiscoveredModel): RouteCapabilities {
  return {
    chat: true,
    tools: model.capability === "CHAT_AND_TOOLS",
    streaming: true,
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
): Pick<
  ProductionComposition,
  | "providerDirectory"
  | "credentialBindings"
  | "providerConnections"
  | "modelIdentities"
  | "routeCatalog"
  | "runtimeBridge"
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
      async () => {
        const adapter = registry.getAdapter(providerId);
        if (adapter === undefined) throw new Error("Provider adapter is unavailable");
        return adapter.discoverModels();
      },
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
  const accounts: Account[] = [];
  const products: ProviderProduct[] = [];
  const connectionByProvider = new Map<string, ProviderConnection>();

  for (const providerId of registeredProviders) {
    const definition = providerDirectory.get(providerId);
    if (definition === undefined) continue;
    const facts = connectionFacts(providerId, config);
    const accountId = `account:${providerId}:default`;
    const productId = `product:${providerId}:default`;
    const account: Account = {
      accountId,
      providerId,
      label: `${definition.displayName} default account`,
    };
    const product: ProviderProduct = {
      productId,
      accountId,
      providerId,
      kind: productKindForBillingClass(facts.billingClass),
      label: definition.displayName,
    };
    accounts.push(account);
    products.push(product);

    const connectionId = buildConnectionId({
      providerId,
      accountId,
      productId,
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
      accountId,
      productId,
      secretRef: facts.secretRef,
      purpose: "execution",
      enabled: true,
    });
    const connection = providerConnections.add({
      connectionId,
      providerId,
      accountId,
      productId,
      connectionKind: facts.connectionKind,
      executionCredentialBindingId: bindingId,
      ...(facts.profileRef !== undefined ? { profileRef: facts.profileRef } : {}),
      ...(facts.endpointRef !== undefined ? { endpointRef: facts.endpointRef } : {}),
      status: "configured",
    });
    connectionByProvider.set(providerId, connection);
  }

  for (const model of registry.listModels()) {
    const connection = connectionByProvider.get(model.provider);
    if (connection === undefined) continue;
    const canonicalName = canonicalModelIdentityName(model.provider, model.upstreamModel);
    const modelIdentityId = buildModelIdentityId({ canonicalName });
    modelIdentities.upsertExplicit({
      modelIdentityId,
      canonicalName,
      aliases: [model.upstreamModel],
    });
    modelIdentities.bindProviderModel({
      providerId: model.provider,
      connectionId: connection.connectionId,
      providerModelId: model.upstreamModel,
      modelIdentityId,
    });
    let routeId: string;
    try {
      routeId = buildRouteId({
        providerId: model.provider,
        connectionId: connection.connectionId,
        providerModelId: model.upstreamModel,
        executionProfile: "default",
      });
    } catch {
      // Stable route IDs deliberately reject unsafe opaque segments. Preserve
      // the discovered model identity/history but do not create an executable
      // catalog route by rewriting or guessing the provider-native model id.
      continue;
    }
    routeCatalog.upsert({
      routeId,
      modelIdentityId,
      connectionId: connection.connectionId,
      providerId: model.provider,
      providerModelId: model.upstreamModel,
      executionProfile: "default",
      capabilities: modelCapabilities(model),
      billingClass: connectionFacts(model.provider, config).billingClass,
      routable: routeIsActivated(model.provider, model.upstreamModel, config),
      visibility: {
        visibleOn:
          model.capability === "CHAT_ONLY"
            ? ["cmmchat_model_picker", "admin_console"]
            : ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"],
      },
    });
  }

  const runtimeBridge = new CatalogRuntimeBridge({
    catalog: routeCatalog,
    connections: providerConnections,
    registry,
  });

  return {
    providerDirectory,
    credentialBindings,
    providerConnections,
    modelIdentities,
    routeCatalog,
    runtimeBridge,
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
  const configDir = process.env.CMM_CONFIG_DIR;
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
      ...composeSharedCatalog(resolved, registry, registeredProviders),
    };
  }

  if (resolved.providers.chatgpt.enabled) {
    const codexHome = resolveChatgptCodexHome(resolved);
    const adapter = new CodexAdapter({
      ...(codexHome ? { codexHome } : {}),
      broker: toolBroker,
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
    });
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
  } else {
    skippedProviders.push({ id: "claude", reason: "disabled in config" });
  }

  if (resolved.providers.google.enabled) {
    const agyPath = resolveGoogleAgyPath(resolved);
    const adapter = new AntigravityAdapter(
      undefined,
      undefined,
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
    // Never instantiate the spend-guarded provider without its ack.
    if (!isCommandCodeAckValid()) {
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

  return {
    config: resolved,
    registry,
    usageStore,
    registeredProviders,
    skippedProviders,
    toolBroker,
    ...composeSharedCatalog(resolved, registry, registeredProviders),
  };
}

export function createProductionServer(composition: ProductionComposition, bearerSecret: string, qoderSecret?: string) {
  return buildServer({
    host: composition.config.host,
    port: composition.config.port,
    bearerSecret,
    ...(qoderSecret !== undefined ? { qoderToken: qoderSecret } : {}),
    registry: composition.registry,
    usageStore: composition.usageStore,
    runtimeBridge: composition.runtimeBridge,
  });
}

async function main() {
  const composition = await createProductionRegistry();
  const { config, registry, usageStore, registeredProviders, skippedProviders } = composition;

  console.log(`Starting CMM Routers on ${config.host}:${config.port}`);
  console.log(`Machine ID: ${config.machineId}`);
  console.log(`Registered providers: ${registeredProviders.join(", ") || "(none)"}`);
  for (const skipped of skippedProviders) {
    console.log(`Skipped provider ${skipped.id}: ${skipped.reason}`);
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

  const server = createProductionServer(composition, bearerSecret, qoderSecret);

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
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
