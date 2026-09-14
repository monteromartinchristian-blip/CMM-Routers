import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { createProductionRegistry } from "../../src/index.js";
import { loadConfig } from "../../src/config/load-config.js";
import { catalogFetch, waveAdapter } from "../helpers/wave-fixtures.js";

/** Vikey catalog fixture: ids with vendor prefixes and version tags. */
const VIKEY_CATALOG = {
  data: [
    { id: "vikey/prime-1.0", name: "Vikey Prime 1.0" },
    { id: "vendor/model-x:2026-01", name: "Model X (2026-01)" },
    { id: "totally-unprefixed-id" },
  ],
};

describe("Vikey", () => {
  it("registers the Vikey identity with its own credential namespace", () => {
    const manifest = providerWaveManifest("vikey");

    expect(manifest.id).toBe("vikey");
    expect(manifest.displayName).toBe("Vikey");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "VIKEY_API_KEY" });
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
    expect(manifest.billingClass).toBe("api");
    expect(manifest.activation).toEqual({ mode: "all", models: [] });
  });

  it("invents no endpoint: the base URL must come from configuration", () => {
    expect(providerWaveManifest("vikey").baseUrl).toBeNull();
  });

  it("discovers through a configured endpoint with bearer auth and exact model ids", async () => {
    const { fetchFn, requests } = catalogFetch(VIKEY_CATALOG);
    const adapter = waveAdapter("vikey", {
      fetchFn,
      baseUrl: "https://vikey.example-account.invalid/v1",
    });

    const models = await adapter.discoverModels();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://vikey.example-account.invalid/v1/models");
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers.Authorization).toMatch(/^Bearer /);
    expect(models.map((model) => model.upstreamModel)).toEqual([
      "vikey/prime-1.0",
      "vendor/model-x:2026-01",
      "totally-unprefixed-id",
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "vikey/vikey/prime-1.0",
      "vikey/vendor/model-x:2026-01",
      "vikey/totally-unprefixed-id",
    ]);
  });

  it("publishes CHAT_ONLY until a tool-calling round-trip is proven for Vikey", () => {
    expect(providerWaveManifest("vikey").toolCapability).toBe("CHAT_ONLY");
  });
});

describe("Vikey production composition", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-vikey-"));
    process.env = { ...savedEnv };
    process.env.VIKEY_API_KEY = "injected-vikey-secret";
    delete process.env.QWEN_CLOUD_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(providers: Record<string, unknown>) {
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
          ...providers,
        },
      }),
    );
  }

  it("skips an enabled Vikey route that has no configured base URL", async () => {
    writeConfig({ vikey: { enabled: true } });

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(VIKEY_CATALOG).fetchFn,
    });

    expect(composition.registeredProviders).not.toContain("vikey");
    const skipped = composition.skippedProviders.find((entry) => entry.id === "vikey");
    expect(skipped?.reason).toContain("baseUrl");
  });

  it("registers and discovers once the operator supplies the endpoint", async () => {
    writeConfig({
      vikey: { enabled: true, baseUrl: "https://vikey.example-account.invalid/v1" },
    });

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(VIKEY_CATALOG).fetchFn,
    });

    expect(composition.registeredProviders).toContain("vikey");
    expect(composition.registry.listModels().map((model) => model.id)).toContain(
      "vikey/vikey/prime-1.0",
    );
  });
});
