import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleClient,
  type ProviderFetchFn,
} from "../../src/providers/openai-compatible/adapter.js";
import {
  GENERIC_WAVE_MANIFESTS,
  providerWaveManifest,
  resolveEffectiveActivation,
  assertProviderWaveInventory,
} from "../../src/providers/manifests.js";
import { createProductionRegistry } from "../../src/index.js";
import { loadConfig } from "../../src/config/load-config.js";

const IDENTICAL_CATALOG = {
  data: [
    { id: "qwen3-max", name: "Qwen3 Max" },
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
  ],
};

function catalogFetch(): ProviderFetchFn {
  return async () => ({ status: 200, text: async () => JSON.stringify(IDENTICAL_CATALOG) });
}

function adapterFor(id: "qwen-token-plan" | "qwen-cloud", baseUrl: string, secret: string) {
  const manifest = providerWaveManifest(id);
  return new OpenAiCompatibleAdapter({
    manifest,
    baseUrl,
    client: new OpenAiCompatibleClient({
      baseUrl,
      secretEnv: manifest.auth.secretEnv,
      secret,
      providerLabel: manifest.displayName,
      fetchFn: catalogFetch(),
    }),
  });
}

describe("Qwen Token Plan and Qwen Cloud PAYG are separate providers", () => {
  it("keeps distinct identities, credential namespaces and billing classes", () => {
    const tokenPlan = providerWaveManifest("qwen-token-plan");
    const payg = providerWaveManifest("qwen-cloud");

    expect(tokenPlan.id).not.toBe(payg.id);
    expect(tokenPlan.auth.secretEnv).toBe("QWEN_TOKEN_PLAN_API_KEY");
    expect(payg.auth.secretEnv).toBe("QWEN_CLOUD_API_KEY");
    expect(tokenPlan.auth.secretEnv).not.toBe(payg.auth.secretEnv);
    expect(tokenPlan.billingClass).toBe("subscription");
    expect(payg.billingClass).toBe("payg");
    expect(tokenPlan.displayName).not.toBe(payg.displayName);
  });

  it("requires each product's own base URL instead of guessing a region", () => {
    for (const id of ["qwen-token-plan", "qwen-cloud"] as const) {
      expect(providerWaveManifest(id).baseUrl).toBeNull();
    }
  });

  it("routes an identical model id through two independent provider routes", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      adapterFor("qwen-token-plan", "https://token-plan.example.maas.aliyuncs.com/compatible-mode/v1", "token-plan-secret"),
    );
    await registry.register(
      adapterFor("qwen-cloud", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "payg-secret"),
    );

    const fromTokenPlan = await registry.resolve("qwen-token-plan/qwen3-max");
    const fromPayg = await registry.resolve("qwen-cloud/qwen3-max");

    expect(fromTokenPlan.provider).toBe("qwen-token-plan");
    expect(fromPayg.provider).toBe("qwen-cloud");
    expect(fromTokenPlan.upstreamModel).toBe("qwen3-max");
    expect(fromPayg.upstreamModel).toBe("qwen3-max");
    expect(fromTokenPlan.id).not.toBe(fromPayg.id);
    // Both routes stay visible; neither shadows the other in the catalog.
    const catalog = registry.listModels().map((model) => model.id).sort();
    expect(catalog).toEqual([
      "qwen-cloud/qwen3-coder-plus",
      "qwen-cloud/qwen3-max",
      "qwen-token-plan/qwen3-coder-plus",
      "qwen-token-plan/qwen3-max",
    ]);
  });

  it("publishes the manifest activation unless the config states one", () => {
    const manifest = providerWaveManifest("qwen-token-plan");
    expect(resolveEffectiveActivation(manifest, undefined)).toEqual({
      mode: "all",
      models: [],
    });
    expect(
      resolveEffectiveActivation(manifest, { mode: "allowlist", models: ["qwen3-max"] }),
    ).toEqual({ mode: "allowlist", models: ["qwen3-max"] });
    expect(resolveEffectiveActivation(manifest, { mode: "none" })).toEqual({
      mode: "none",
      models: [],
    });
  });

  it("asserts a unique wave inventory", () => {
    expect(() => assertProviderWaveInventory()).not.toThrow();
    expect(GENERIC_WAVE_MANIFESTS.map((manifest) => manifest.id)).toContain(
      "qwen-token-plan",
    );
    expect(GENERIC_WAVE_MANIFESTS.map((manifest) => manifest.id)).toContain("qwen-cloud");
  });
});

describe("production composition of the Qwen routes", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-qwen-"));
    process.env = { ...savedEnv };
    delete process.env.QWEN_TOKEN_PLAN_API_KEY;
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

  it("skips a base-URL-less provider instead of inventing a host", async () => {
    process.env.QWEN_TOKEN_PLAN_API_KEY = "injected-token-plan-secret";
    writeConfig({ "qwen-token-plan": { enabled: true } });

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(),
    });

    expect(composition.registeredProviders).not.toContain("qwen-token-plan");
    const skipped = composition.skippedProviders.find((entry) => entry.id === "qwen-token-plan");
    expect(skipped?.reason).toContain("baseUrl");
  });

  it("registers the configured PAYG route and discovers its catalog without network", async () => {
    process.env.QWEN_CLOUD_API_KEY = "injected-payg-secret";
    writeConfig({
      "qwen-cloud": {
        enabled: true,
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    });

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(),
    });

    expect(composition.registeredProviders).toContain("qwen-cloud");
    const models = composition.registry.listModels().map((model) => model.id);
    expect(models).toEqual([
      "qwen-cloud/qwen3-max",
      "qwen-cloud/qwen3-coder-plus",
    ]);
  });

  it("skips a configured route whose credential namespace is absent", async () => {
    writeConfig({
      "qwen-cloud": {
        enabled: true,
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    });

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(),
    });

    expect(composition.registeredProviders).not.toContain("qwen-cloud");
    const skipped = composition.skippedProviders.find((entry) => entry.id === "qwen-cloud");
    expect(skipped?.reason).toContain("QWEN_CLOUD_API_KEY");
  });
});
