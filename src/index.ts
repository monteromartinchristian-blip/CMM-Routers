import { loadConfig } from "./config/load-config.js";
import { ProviderRegistry } from "./registry/provider-registry.js";
import { buildServer } from "./http/server.js";

async function main() {
  const config = loadConfig();

  console.log(`Starting CMM Subscription Router on ${config.host}:${config.port}`);
  console.log(`Machine ID: ${config.machineId}`);

  const registry = new ProviderRegistry();

  // TODO: Register provider adapters here in future tasks
  // await registry.register(codexAdapter);
  // await registry.register(claudeAdapter);
  // await registry.register(antigravityAdapter);
  // await registry.register(commandCodeAdapter);

  await registry.refresh();

  const bearerSecret = process.env[config.bearerSecretEnv];
  if (!bearerSecret) {
    console.error(
      `Error: Bearer secret environment variable ${config.bearerSecretEnv} is not set`,
    );
    process.exit(1);
  }

  const server = buildServer({
    host: config.host,
    port: config.port,
    bearerSecret,
    registry,
  });

  try {
    await server.listen({ host: config.host, port: config.port });
    console.log(`Server listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
