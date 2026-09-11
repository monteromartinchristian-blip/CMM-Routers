import { ensureSharedConfigFromExample, loadConfig, type RouterConfig } from "./config/load-config.js";
import { ProviderRegistry } from "./registry/provider-registry.js";
import { buildServer } from "./http/server.js";
import { UsageStore } from "./observability/usage-store.js";
import { requireSpendAcknowledgement } from "./providers/command-code/spend-guard.js";
import { CodexAdapter } from "./providers/codex/adapter.js";
import { ClaudeAdapter } from "./providers/claude/adapter.js";
import { AntigravityAdapter } from "./providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "./providers/command-code/adapter.js";
import { DeferredToolBroker } from "./core/deferred-tool-broker.js";

export interface ProductionComposition {
  config: RouterConfig;
  registry: ProviderRegistry;
  usageStore: UsageStore;
  registeredProviders: string[];
  skippedProviders: Array<{ id: string; reason: string }>;
  /**
   * Single Router-owned bounded pending-tool broker shared by every provider
   * adapter that needs cross-request Qoder tool correlation. Injected
   * explicitly; never a per-adapter instance in production.
   */
  toolBroker: DeferredToolBroker;
}

function isCommandCodeAckValid(): boolean {
  try {
    requireSpendAcknowledgement();
    return true;
  } catch {
    return false;
  }
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
): Promise<ProductionComposition> {
  // Fresh-clone bootstrap: a clean checkout ships only
  // config/shared.example.json. Install it as shared.json (never
  // overwriting, never secrets) before parsing. CMM_CONFIG_DIR isolates
  // the compiled-process E2E onto a temp config dir.
  const configDir = process.env.CMM_CONFIG_DIR;
  if (!config) ensureSharedConfigFromExample(configDir);
  const resolved = config ?? loadConfig(configDir);
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
    return { config: resolved, registry, usageStore, registeredProviders, skippedProviders, toolBroker };
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

  await registry.refresh();

  return { config: resolved, registry, usageStore, registeredProviders, skippedProviders, toolBroker };
}

export function createProductionServer(composition: ProductionComposition, bearerSecret: string, qoderSecret?: string) {
  return buildServer({
    host: composition.config.host,
    port: composition.config.port,
    bearerSecret,
    ...(qoderSecret !== undefined ? { qoderToken: qoderSecret } : {}),
    registry: composition.registry,
    usageStore: composition.usageStore,
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
