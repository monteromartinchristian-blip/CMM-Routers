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
import { catalogFetch as recordingCatalogFetch } from "../helpers/wave-fixtures.js";

/** Token Plan's fixed dedicated subscription endpoint (never a PAYG host). */
const TOKEN_PLAN_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

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

  it("pins the Token Plan subscription endpoint and keeps PAYG configuration-required", () => {
    // Token Plan is a fixed dedicated subscription endpoint with `sk-sp-`
    // credentials: its default is deterministically known and must be exact.
    expect(providerWaveManifest("qwen-token-plan").baseUrl).toBe(TOKEN_PLAN_BASE_URL);

    // PAYG endpoints are workspace/region-specific, so no region may be
    // hardcoded: the manifest stays connection-required and fails closed.
    expect(providerWaveManifest("qwen-cloud").baseUrl).toBeNull();
  });

  it("cannot silently inherit PAYG credentials or a PAYG endpoint", () => {
    const tokenPlan = providerWaveManifest("qwen-token-plan");
    const payg = providerWaveManifest("qwen-cloud");

    // Distinct credential namespace, billing class and endpoint: sharing any
    // one of them would let one product spend the other product's account.
    expect(tokenPlan.auth.secretEnv).not.toBe(payg.auth.secretEnv);
    expect(tokenPlan.billingClass).not.toBe(payg.billingClass);
    expect(tokenPlan.baseUrl).not.toBe(payg.baseUrl);
    expect(tokenPlan.baseUrl).not.toContain("dashscope");

    // No manifest in the catalog offers a legacy global DashScope endpoint, so
    // nothing can fall back to one behind the operator's back.
    for (const manifest of GENERIC_WAVE_MANIFESTS) {
      expect(manifest.baseUrl ?? "", manifest.id).not.toMatch(
        /^https:\/\/dashscope\.aliyuncs\.com/,
      );
      expect(manifest.baseUrl ?? "", manifest.id).not.toMatch(/api[-.]?key=/);
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

  it("registers the Token Plan route from its fixed default endpoint", async () => {
    process.env.QWEN_TOKEN_PLAN_API_KEY = "injected-token-plan-secret";
    writeConfig({ "qwen-token-plan": { enabled: true } });

    const discovery = recordingCatalogFetch(IDENTICAL_CATALOG);
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: discovery.fetchFn,
    });

    expect(composition.registeredProviders).toContain("qwen-token-plan");
    expect(discovery.requests).toHaveLength(1);
    expect(discovery.requests[0]!.url).toBe(`${TOKEN_PLAN_BASE_URL}/models`);
    expect(discovery.requests[0]!.method).toBe("GET");
    expect(
      composition.registry.listModels().map((model) => model.id),
    ).toEqual(["qwen-token-plan/qwen3-max", "qwen-token-plan/qwen3-coder-plus"]);
  });

  it("fails the PAYG route closed instead of inventing a host or falling back", async () => {
    process.env.QWEN_CLOUD_API_KEY = "injected-payg-secret";
    writeConfig({ "qwen-cloud": { enabled: true } });

    const discovery = recordingCatalogFetch(IDENTICAL_CATALOG);
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: discovery.fetchFn,
    });

    expect(composition.registeredProviders).not.toContain("qwen-cloud");
    const skipped = composition.skippedProviders.find((entry) => entry.id === "qwen-cloud");
    expect(skipped?.reason).toContain("baseUrl");

    // Fail closed: no discovery request at all, so no fallback to the Token
    // Plan endpoint and none to a legacy global DashScope endpoint.
    expect(discovery.requests).toEqual([]);
    expect(
      composition.registry.listModels().some((model) => model.provider === "qwen-cloud"),
    ).toBe(false);
    await expect(composition.registry.resolve("qwen-cloud/qwen3-max")).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("registers the configured PAYG route and discovers its catalog without network", async () => {
    process.env.QWEN_CLOUD_API_KEY = "injected-payg-secret";
    writeConfig({
      "qwen-cloud": {
        enabled: true,
        baseUrl: "https://dashscope-us.example-account.invalid/compatible-mode/v1",
      },
    });

    const discovery = recordingCatalogFetch(IDENTICAL_CATALOG);
    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: discovery.fetchFn,
    });

    expect(composition.registeredProviders).toContain("qwen-cloud");
    // The operator-supplied workspace/region endpoint is the effective one, and
    // the PAYG route never borrows the Token Plan host.
    expect(discovery.requests[0]!.url).toBe(
      "https://dashscope-us.example-account.invalid/compatible-mode/v1/models",
    );
    expect(discovery.requests[0]!.url).not.toContain("token-plan");
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
