import { ensureSharedConfigFromExample, loadConfig, type RouterConfig } from "./config/load-config.js";
import { ProviderRegistry } from "./registry/provider-registry.js";
import { buildServer } from "./http/server.js";
import { UsageStore } from "./observability/usage-store.js";
import { requireSpendAcknowledgement } from "./providers/command-code/spend-guard.js";
import { CodexAdapter } from "./providers/codex/adapter.js";
import { ClaudeAdapter } from "./providers/claude/adapter.js";
import { AntigravityAdapter } from "./providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "./providers/command-code/adapter.js";

export interface ProductionComposition {
  config: RouterConfig;
  registry: ProviderRegistry;
  usageStore: UsageStore;
  registeredProviders: string[];
  skippedProviders: Array<{ id: string; reason: string }>;
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

export async function createProductionRegistry(
  config?: RouterConfig,
): Promise<ProductionComposition> {
  // Fresh-clone bootstrap: a clean checkout ships only
  // config/shared.example.json. Install it as shared.json (never
  // overwriting, never secrets) before parsing.
  if (!config) ensureSharedConfigFromExample();
  const resolved = config ?? loadConfig();
  const registry = new ProviderRegistry();
  const usageStore = new UsageStore();
  const registeredProviders: string[] = [];
  const skippedProviders: Array<{ id: string; reason: string }> = [];

  if (resolved.providers.chatgpt.enabled) {
    const codexHome = resolveChatgptCodexHome(resolved);
    const adapter = new CodexAdapter(codexHome ? { codexHome } : {});
    await registry.register(adapter);
    registeredProviders.push(adapter.id);
  } else {
    skippedProviders.push({ id: "chatgpt", reason: "disabled in config" });
  }

  if (resolved.providers.claude.enabled) {
    // Explicit runtime injection: the adapter builds its isolated SDK env
    // from this value per request. No global process.env mutation — the
    // configured profile is effective even though sdk-client was imported
    // long before this factory runs.
    const profileDir = resolveClaudeProfileDir(resolved);
    const adapter = new ClaudeAdapter(profileDir ? { profileDir } : {});
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
      agyPath ? { agyPath } : {},
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

  return { config: resolved, registry, usageStore, registeredProviders, skippedProviders };
}

export function createProductionServer(composition: ProductionComposition, bearerSecret: string) {
  return buildServer({
    host: composition.config.host,
    port: composition.config.port,
    bearerSecret,
    registry: composition.registry,
    usageStore: composition.usageStore,
  });
}

async function main() {
  const composition = await createProductionRegistry();
  const { config, registry, usageStore, registeredProviders, skippedProviders } = composition;

  console.log(`Starting CMM Subscription Router on ${config.host}:${config.port}`);
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

  const server = createProductionServer(composition, bearerSecret);

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
