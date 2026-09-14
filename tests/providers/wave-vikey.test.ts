import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { createProductionRegistry } from "../../src/index.js";
import { loadConfig } from "../../src/config/load-config.js";
import { catalogFetch, TEST_SECRET, waveAdapter } from "../helpers/wave-fixtures.js";

/** Vikey catalog fixture: ids with vendor prefixes and version tags. */
const VIKEY_CATALOG = {
  data: [
    { id: "vikey/prime-1.0", name: "Vikey Prime 1.0" },
    { id: "vendor/model-x:2026-01", name: "Model X (2026-01)" },
    { id: "totally-unprefixed-id" },
  ],
};

/** Vikey's canonical OpenAI-compatible endpoint. */
const VIKEY_BASE_URL = "https://api.vikey.ai/v1";

/** Paths that would make administrative discovery a billable generation call. */
const GENERATION_PATH_PATTERNS = [
  /\/chat\/completions/,
  /\/messages/,
  /\/responses/,
  /\/generate/,
  /\/embeddings/,
];

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

  it("declares the canonical endpoint as its default base URL", () => {
    expect(providerWaveManifest("vikey").baseUrl).toBe(VIKEY_BASE_URL);
  });

  it("discovers through the default endpoint with bearer auth and exact model ids", async () => {
    const { fetchFn, requests } = catalogFetch(VIKEY_CATALOG);
    // No baseUrl passed: the manifest default must be the effective endpoint.
    const adapter = waveAdapter("vikey", { fetchFn });

    const models = await adapter.discoverModels();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${VIKEY_BASE_URL}/models`);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers.Authorization).toBe(`Bearer ${TEST_SECRET}`);
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

  it("performs administrative model discovery only, never a generation call", async () => {
    const { fetchFn, requests } = catalogFetch(VIKEY_CATALOG);
    const adapter = waveAdapter("vikey", { fetchFn });

    await adapter.discoverModels();

    for (const request of requests) {
      expect(request.method, request.url).toBe("GET");
      expect(request.body, `${request.url} must carry no generation body`).toBeNull();
      for (const pattern of GENERATION_PATH_PATTERNS) {
        expect(request.url, `${request.url} must not be a generation path`).not.toMatch(
          pattern,
        );
      }
    }
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

  it("registers and discovers from the canonical default endpoint", async () => {
    writeConfig({ vikey: { enabled: true } });

    const discovery = catalogFetch(VIKEY_CATALOG);
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: discovery.fetchFn,
    });

    expect(composition.registeredProviders).toContain("vikey");
    expect(discovery.requests[0]!.url).toBe(`${VIKEY_BASE_URL}/models`);
    expect(composition.registry.listModels().map((model) => model.id)).toContain(
      "vikey/vikey/prime-1.0",
    );
  });

  it("lets an operator-supplied endpoint override the default", async () => {
    writeConfig({
      vikey: { enabled: true, baseUrl: "https://vikey.example-account.invalid/v1" },
    });

    const discovery = catalogFetch(VIKEY_CATALOG);
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: discovery.fetchFn,
    });

    expect(composition.registeredProviders).toContain("vikey");
    expect(discovery.requests[0]!.url).toBe(
      "https://vikey.example-account.invalid/v1/models",
    );
  });
});
