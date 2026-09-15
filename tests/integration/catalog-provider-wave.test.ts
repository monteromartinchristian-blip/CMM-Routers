import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { createProductionRegistry } from "../../src/index.js";
import {
  PROVIDER_WAVE_MANIFESTS,
  SUBSCRIPTION_BRIDGE_IDS,
} from "../../src/providers/manifests.js";
import { catalogFetch } from "../helpers/wave-fixtures.js";

const savedEnv = { ...process.env };

const WAVE_SECRET_ENVS = [
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_CLOUD_API_KEY",
  "DEEPSEEK_API_KEY",
  "KIRA_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "VIKEY_API_KEY",
  "CLINE_API_KEY",
  "OLLAMA_CLOUD_API_KEY",
] as const;

function deterministicConfig() {
  return {
    ...sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      cavoti: { enabled: false },
      "qwen-token-plan": {
        enabled: true,
        baseUrl: "https://token-plan.example.invalid/compatible-mode/v1",
      },
      "qwen-cloud": {
        enabled: true,
        baseUrl: "https://qwen-cloud.example.invalid/compatible-mode/v1",
      },
      deepseek: { enabled: true },
      kira: { enabled: true },
      openrouter: { enabled: true },
      "opencode-zen": { enabled: true },
      "nvidia-nim": { enabled: true },
      vikey: { enabled: true },
      cline: { enabled: true },
      "ollama-cloud": { enabled: true },
    },
    }),
    machineId: "catalog-provider-wave-test",
  };
}

describe("production shared catalog composition", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    for (const envName of WAVE_SECRET_ENVS) {
      process.env[envName] = `fixture-${envName.toLowerCase()}`;
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("composes the real provider wave into connections, identities and routes without Usage fixtures", async () => {
    const transport = catalogFetch({
      data: [
        { id: "qwen3.8-max" },
        { id: "moonshotai/kimi-k3" },
        { id: "provider-extra-model" },
      ],
    });

    const composition = await createProductionRegistry(deterministicConfig(), {
      fetchFn: transport.fetchFn,
    });

    expect(composition.providerDirectory.list().map((provider) => provider.providerId)).toEqual(
      expect.arrayContaining([
        ...SUBSCRIPTION_BRIDGE_IDS,
        ...PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id),
      ]),
    );

    const registeredWave = PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id).filter(
      (providerId) => providerId !== "command-code" && providerId !== "cavoti",
    );
    for (const providerId of registeredWave) {
      expect(composition.registeredProviders).toContain(providerId);
      expect(
        composition.providerConnections.list().some((connection) => connection.providerId === providerId),
      ).toBe(true);
    }

    const qwenPlanConnection = composition.providerConnections
      .list()
      .find((connection) => connection.providerId === "qwen-token-plan");
    const qwenCloudConnection = composition.providerConnections
      .list()
      .find((connection) => connection.providerId === "qwen-cloud");
    expect(qwenPlanConnection).toBeDefined();
    expect(qwenCloudConnection).toBeDefined();
    expect(qwenPlanConnection?.connectionId).not.toBe(qwenCloudConnection?.connectionId);
    expect(qwenPlanConnection?.productId).not.toBe(qwenCloudConnection?.productId);

    expect(
      composition.providerDirectory.get("command-code")?.adapterKind,
    ).toBe("command-code");

    const nimRoutes = composition.routeCatalog
      .list()
      .filter((route) => route.providerId === "nvidia-nim");
    expect(nimRoutes.find((route) => route.providerModelId === "moonshotai/kimi-k3")?.routable).toBe(true);
    expect(
      nimRoutes.filter((route) => route.providerModelId !== "moonshotai/kimi-k3").every((route) => !route.routable),
    ).toBe(true);
    expect(
      nimRoutes
        .filter((route) => route.providerModelId !== "moonshotai/kimi-k3")
        .every((route) => route.visibility.visibleOn.includes("cmmchat_model_picker")),
    ).toBe(true);

    for (const providerId of ["kira", "vikey"] as const) {
      const route = composition.routeCatalog.list().find((candidate) => candidate.providerId === providerId);
      expect(route?.capabilities.tools).toBe(false);
    }

    expect(composition.providerDirectory.has("cmm-usage-fixture")).toBe(false);
    expect(
      composition.modelIdentities.list().some((identity) => /cmm usage fixture/i.test(identity.canonicalName)),
    ).toBe(false);

    const qwenPlanRoute = composition.routeCatalog.list().find(
      (route) => route.providerId === "qwen-token-plan" && route.providerModelId === "qwen3.8-max",
    );
    const qwenCloudRoute = composition.routeCatalog.list().find(
      (route) => route.providerId === "qwen-cloud" && route.providerModelId === "qwen3.8-max",
    );
    expect(qwenPlanRoute).toBeDefined();
    expect(qwenCloudRoute).toBeDefined();
    expect(qwenPlanRoute?.routeId).not.toBe(qwenCloudRoute?.routeId);
    expect(qwenPlanRoute?.modelIdentityId).toBe(qwenCloudRoute?.modelIdentityId);

    expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
    expect(transport.requests.every((request) => /\/models$/.test(request.url))).toBe(true);
  });

  it("uses effective configured activation for catalog routability", async () => {
    const config = deterministicConfig();
    config.providers["qwen-token-plan"].activation = {
      mode: "allowlist",
      models: ["qwen3.8-max"],
    };
    config.providers["nvidia-nim"].activation = {
      mode: "allowlist",
      models: ["provider-extra-model"],
    };
    config.providers.deepseek.activation = { mode: "none" };

    const transport = catalogFetch({
      data: [
        { id: "qwen3.8-max" },
        { id: "moonshotai/kimi-k3" },
        { id: "provider-extra-model" },
      ],
    });

    const composition = await createProductionRegistry(config, {
      fetchFn: transport.fetchFn,
    });

    const qwenPlanRoutes = composition.routeCatalog
      .list()
      .filter((route) => route.providerId === "qwen-token-plan");
    expect(qwenPlanRoutes.find((route) => route.providerModelId === "qwen3.8-max")?.routable).toBe(
      true,
    );
    expect(
      qwenPlanRoutes.find((route) => route.providerModelId === "provider-extra-model")?.routable,
    ).toBe(false);

    const nimRoutes = composition.routeCatalog
      .list()
      .filter((route) => route.providerId === "nvidia-nim");
    expect(
      nimRoutes.find((route) => route.providerModelId === "provider-extra-model")?.routable,
    ).toBe(true);
    expect(
      nimRoutes.find((route) => route.providerModelId === "moonshotai/kimi-k3")?.routable,
    ).toBe(false);

    expect(composition.registeredProviders).toContain("deepseek");
    expect(
      composition.routeCatalog.list().some((route) => route.providerId === "deepseek"),
    ).toBe(false);
  });
});
