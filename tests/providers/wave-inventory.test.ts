import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_WAVE_MANIFESTS,
  SUBSCRIPTION_BRIDGE_IDS,
  assertProviderWaveInventory,
  providerInventory,
  subscriptionBridgeDefinitions,
} from "../../src/providers/manifests.js";
import { PROVIDER_BILLING_CLASSES } from "../../src/providers/manifest.js";
import {
  WAVE_PROVIDER_IDS,
  sharedConfigSchema,
  waveProviderConfig,
} from "../../src/config/schema.js";
import { createProductionRegistry } from "../../src/index.js";
import { loadConfig } from "../../src/config/load-config.js";
import { buildServer } from "../../src/http/server.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import { catalogFetch } from "../helpers/wave-fixtures.js";

/**
 * Approved provider wave as named by the plan. `commandcode` is the plan's
 * inventory token for the already-registered `command-code` route (ledger R4:
 * the live route namespace is not renamed).
 */
const APPROVED_WAVE_INVENTORY = [
  "qwen-token-plan",
  "qwen-cloud",
  "commandcode",
  "deepseek",
  "kira",
  "openrouter",
  "opencode-zen",
  "nvidia-nim",
  "vikey",
  "cavoti",
  "cline",
  "ollama-cloud",
] as const;

const INVENTORY_TOKEN_TO_ROUTE_ID: Record<string, string> = {
  commandcode: "command-code",
};

const WAVE_CREDENTIALS: ReadonlyArray<readonly [string, string]> = [
  ["qwen-token-plan", "QWEN_TOKEN_PLAN_API_KEY"],
  ["qwen-cloud", "QWEN_CLOUD_API_KEY"],
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["kira", "KIRA_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
  ["opencode-zen", "OPENCODE_ZEN_API_KEY"],
  ["nvidia-nim", "NVIDIA_NIM_API_KEY"],
  ["vikey", "VIKEY_API_KEY"],
  ["cline", "CLINE_API_KEY"],
  ["ollama-cloud", "OLLAMA_CLOUD_API_KEY"],
];

function routeIdFor(token: string): string {
  return INVENTORY_TOKEN_TO_ROUTE_ID[token] ?? token;
}

describe("expanded provider inventory", () => {
  it("contains every approved provider exactly once", () => {
    const manifestIds = PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    expect(manifestIds).toHaveLength(APPROVED_WAVE_INVENTORY.length);

    for (const token of APPROVED_WAVE_INVENTORY) {
      const routeId = routeIdFor(token);
      expect(manifestIds.filter((id) => id === routeId), token).toHaveLength(1);
    }
    expect(() => assertProviderWaveInventory()).not.toThrow();
  });

  it("keeps the three subscription bridges present, separate and unchanged", () => {
    expect([...SUBSCRIPTION_BRIDGE_IDS]).toEqual(["chatgpt", "claude", "google"]);
    expect(subscriptionBridgeDefinitions().map((definition) => definition.providerId)).toEqual([
      ...SUBSCRIPTION_BRIDGE_IDS,
    ]);
    for (const bridge of SUBSCRIPTION_BRIDGE_IDS) {
      expect(PROVIDER_WAVE_MANIFESTS.some((manifest) => manifest.id === bridge)).toBe(false);
    }

    // Bridge config contract unchanged (shape proven by the historical suites).
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: true, codexHome: "/tmp/codex" },
        claude: { enabled: false, profileDir: "/tmp/claude" },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      },
    });
    expect(parsed.providers.chatgpt).toEqual({ enabled: true, codexHome: "/tmp/codex" });
    expect(parsed.providers.claude).toEqual({ enabled: false, profileDir: "/tmp/claude" });
    expect(parsed.providers.google).toEqual({ enabled: false });
  });

  it("derives billing metadata from the manifest catalog instead of a second provider list", () => {
    const inventory = providerInventory();
    const manifestIds = PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id);

    expect(inventory.map((entry) => entry.providerId)).toEqual(manifestIds);
    for (const entry of inventory) {
      const manifest = PROVIDER_WAVE_MANIFESTS.find(
        (candidate) => candidate.id === entry.providerId,
      )!;
      expect(entry.billingClass).toBe(manifest.billingClass);
      expect(entry.credentialEnv).toBe(manifest.auth.secretEnv);
      expect(entry.activationMode).toBe(manifest.activation.mode);
      expect(entry.toolCapability).toBe(manifest.toolCapability);
      expect(PROVIDER_BILLING_CLASSES).toContain(entry.billingClass);
      // The credential NAMESPACE is exposed, never a value.
      expect(entry.credentialEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }

    // The config contract and the manifest catalog agree on the wave ids.
    expect([...WAVE_PROVIDER_IDS].sort()).toEqual(
      manifestIds.filter((id) => (WAVE_PROVIDER_IDS as readonly string[]).includes(id)).sort(),
    );
  });

  it("exposes credential namespaces for the whole wave from config defaults", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      },
    });
    for (const [id, secretEnv] of WAVE_CREDENTIALS) {
      const entry = waveProviderConfig(parsed.providers, id as "deepseek");
      expect(entry?.secretEnv, id).toBe(secretEnv);
    }
  });
});

describe("production inventory with usage metadata", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-inventory-"));
    process.env = { ...savedEnv };
    for (const [, secretEnv] of WAVE_CREDENTIALS) {
      process.env[secretEnv] = `injected-${secretEnv.toLowerCase()}`;
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFullWaveConfig() {
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {
          chatgpt: { enabled: true },
          claude: { enabled: true },
          google: { enabled: true },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
          "qwen-token-plan": {
            enabled: true,
            baseUrl: "https://token-plan.test-region.maas.example.invalid/compatible-mode/v1",
          },
          "qwen-cloud": {
            enabled: true,
            baseUrl: "https://dashscope.test-region.aliyuncs.example.invalid/compatible-mode/v1",
          },
          vikey: { enabled: true, baseUrl: "https://vikey.example-account.invalid/v1" },
          deepseek: { enabled: true },
          kira: { enabled: true },
          openrouter: { enabled: true },
          "opencode-zen": { enabled: true },
          "nvidia-nim": { enabled: true },
          cline: { enabled: true },
          "ollama-cloud": { enabled: true },
        },
      }),
    );
  }

  it("registers the three bridges plus the whole wave from one composition root", { timeout: 60_000 }, async () => {
    writeFullWaveConfig();
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch({ data: [{ id: "fixture-model" }] }).fetchFn,
    });

    // Excluded on purpose: command-code and cavoti require their machine-local
    // spend acknowledgements, so with no ack present they must be skipped (and
    // are asserted below) rather than registered insecurely.
    const expected = [
      ...SUBSCRIPTION_BRIDGE_IDS,
      ...PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id).filter(
        (id) => id !== "command-code" && id !== "cavoti",
      ),
    ];
    for (const id of expected) {
      expect(composition.registeredProviders, id).toContain(id);
    }
    const skippedIds = composition.skippedProviders.map((entry) => entry.id);
    expect(skippedIds).toContain("command-code");
    expect(skippedIds).toContain("cavoti");
    expect(new Set(composition.registeredProviders).size).toBe(
      composition.registeredProviders.length,
    );
    console.log(
      `WAVE_REGISTERED_PROVIDER_COUNT=${composition.registeredProviders.length}`,
    );
    console.log("CMM_USAGE_PROVIDER_METADATA_BRIDGE=PASS");
  });

  it("reports billing class and routability per provider, and never a credit balance", { timeout: 60_000 }, async () => {
    writeFullWaveConfig();
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch({ data: [{ id: "fixture-model" }] }).fetchFn,
    });
    const usageStore = new UsageStore();
    usageStore.beginRequest("blocked-1", "cavoti", "cavoti/deepseek-v4.1-flash");
    usageStore.endRequest("blocked-1", {
      status: "billing_blocked",
      errorCode: "provider_billing_blocked",
    });
    usageStore.beginRequest("limited-1", "openrouter", "openrouter/fixture-model");
    usageStore.endRequest("limited-1", {
      status: "rate_limit_error",
      errorCode: "provider_rate_limited",
    });

    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "inventory-secret",
      registry: composition.registry,
      usageStore,
    });

    const providersResponse = await server.inject({
      method: "GET",
      url: "/v1/cmm/providers",
      headers: { authorization: "Bearer inventory-secret" },
    });
    expect(providersResponse.statusCode).toBe(200);
    const providers = providersResponse.json() as {
      providers: Array<{ id: string; modelCount: number; billingClass?: string }>;
    };
    const openrouter = providers.providers.find((entry) => entry.id === "openrouter");
    expect(openrouter?.billingClass).toBe("payg");
    const qwenPlan = providers.providers.find((entry) => entry.id === "qwen-token-plan");
    expect(qwenPlan?.billingClass).toBe("subscription");
    // Routability is reported as a route/catalog fact, never as a balance.
    expect(JSON.stringify(providers).toLowerCase()).not.toMatch(/"(credit|balance|availablecredit)"/);

    const usageResponse = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage",
      headers: { authorization: "Bearer inventory-secret" },
    });
    const usage = usageResponse.json() as Record<string, number>;
    expect(usage.billingBlockedEvents).toBe(1);
    expect(usage.rateLimitEvents).toBe(1);
    expect(usage.quotaEvents).toBe(0);

    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect([200, 503]).toContain(ready.statusCode);
  });
});
