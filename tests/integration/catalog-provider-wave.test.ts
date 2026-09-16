import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedConfigSchema } from "../../src/config/schema.js";
import {
  buildCmmChatRouteProjection,
  buildRouterCatalogProjection,
} from "../../src/catalog/projection.js";
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

function deterministicConfig(routeVisibility?: unknown) {
  return {
    ...sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      ...(routeVisibility !== undefined ? { routeVisibility } : {}),
      providers: {
      chatgpt: { enabled: false },
      claude: { enabled: false },
      google: { enabled: false },
      "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
      cavoti: { enabled: false },
      "qwen-token-plan": {
        enabled: true,
        baseUrl: "https://token-plan.example.invalid/compatible-mode/v1",
        catalog: {
          accounts: [
            {
              ref: "fixture-qwen-token-account",
              label: "Fixture Qwen Token Account",
              identityStatus: "unresolved",
            },
          ],
          products: [
            {
              ref: "token-plan",
              accountRef: "fixture-qwen-token-account",
              kind: "subscription",
              label: "Qwen Token Plan",
            },
          ],
          connections: [
            { ref: "primary", productRef: "token-plan", runtime: "primary" },
          ],
        },
      },
      "qwen-cloud": {
        enabled: true,
        baseUrl: "https://qwen-cloud.example.invalid/compatible-mode/v1",
        catalog: {
          accounts: [
            {
              ref: "fixture-qwen-cloud-account",
              label: "Fixture Qwen Cloud Account",
              identityStatus: "unresolved",
            },
          ],
          products: [
            {
              ref: "cloud-api",
              accountRef: "fixture-qwen-cloud-account",
              kind: "api",
              label: "Qwen Cloud",
            },
          ],
          connections: [
            { ref: "primary", productRef: "cloud-api", runtime: "primary" },
          ],
        },
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

  it("applies exact Router-owned visibility without changing routability or Usage truth", async () => {
    const transport = catalogFetch({ data: [{ id: "qwen3.8-max" }] });
    const baseline = await createProductionRegistry(deterministicConfig(), {
      fetchFn: transport.fetchFn,
    });
    const target = baseline.routeCatalog
      .list()
      .find(
        (route) =>
          route.providerId === "openrouter" && route.providerModelId === "qwen3.8-max",
      );
    expect(target).toBeDefined();

    const config = deterministicConfig([
      {
        routeId: target!.routeId,
        visibleOn: [],
      },
    ]);
    const composition = await createProductionRegistry(config, {
      fetchFn: transport.fetchFn,
    });
    const hidden = composition.routeCatalog.get(target!.routeId);
    expect(hidden).toBeDefined();
    expect(hidden?.routable).toBe(true);
    expect(hidden?.visibility.visibleOn).toEqual([]);

    const catalog = buildRouterCatalogProjection({
      directory: composition.providerDirectory,
      accounts: composition.accounts,
      products: composition.products,
      connections: composition.providerConnections,
      modelIdentities: composition.modelIdentities,
      routeCatalog: composition.routeCatalog,
    });
    expect(catalog.routes.some((route) => route.routeId === hidden?.routeId)).toBe(true);
    expect(buildCmmChatRouteProjection(catalog).some((route) => route.routeId === hidden?.routeId)).toBe(
      false,
    );
  });

  it("uses durable account/product identity and represents secondary connections without overclaiming runtime", async () => {
    process.env.DEEPSEEK_API_KEY = "identity-fixture-secret-a";
    const config = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
        deepseek: {
          enabled: true,
          catalog: {
            accounts: [
              {
                ref: "deepseek-team-a",
                label: "DeepSeek Team A",
                identityStatus: "resolved",
                externalAccountRef: "provider-account-123",
              },
            ],
            products: [
              {
                ref: "api-primary",
                accountRef: "deepseek-team-a",
                kind: "api",
                label: "Primary API",
              },
              {
                ref: "api-secondary",
                accountRef: "deepseek-team-a",
                kind: "api",
                label: "Secondary API",
              },
            ],
            connections: [
              { ref: "primary", productRef: "api-primary", runtime: "primary" },
              { ref: "secondary", productRef: "api-secondary", runtime: "disabled" },
            ],
          },
        },
      },
    });
    const transport = catalogFetch({ data: [{ id: "deepseek-chat" }] });

    const first = await createProductionRegistry(
      { ...config, machineId: "identity-test-a" },
      { fetchFn: transport.fetchFn },
    );
    const account = first.accounts.find((entry) => entry.providerId === "deepseek")!;
    const products = first.products.filter((entry) => entry.providerId === "deepseek");
    const connections = first.providerConnections
      .list()
      .filter((entry) => entry.providerId === "deepseek");
    const routes = first.routeCatalog.list().filter((entry) => entry.providerId === "deepseek");

    expect(account.label).toBe("DeepSeek Team A");
    expect(account.externalAccountRef).toBe("provider-account-123");
    expect(products).toHaveLength(2);
    expect(new Set(products.map((product) => product.productId)).size).toBe(2);
    expect(connections).toHaveLength(2);
    expect(new Set(connections.map((connection) => connection.connectionId)).size).toBe(2);
    expect(connections.filter((connection) => connection.status !== "disabled")).toHaveLength(1);
    expect(connections.find((connection) => connection.status === "disabled")?.executionCredentialBindingId).toBeUndefined();
    expect(routes).toHaveLength(1);

    process.env.DEEPSEEK_API_KEY = "identity-fixture-secret-b";
    const restarted = await createProductionRegistry(
      { ...config, machineId: "identity-test-b" },
      { fetchFn: transport.fetchFn },
    );
    expect(restarted.accounts.find((entry) => entry.providerId === "deepseek")?.accountId).toBe(
      account.accountId,
    );
    expect(
      restarted.products
        .filter((entry) => entry.providerId === "deepseek")
        .map((entry) => entry.productId),
    ).toEqual(products.map((entry) => entry.productId));

    const changedLocalMetadataConfig = sharedConfigSchema.parse({
      ...config,
      providers: {
        ...config.providers,
        deepseek: {
          ...config.providers.deepseek,
          catalog: {
            ...config.providers.deepseek.catalog,
            accounts: [
              {
                ref: "renamed-local-account",
                label: "Renamed Local Label",
                identityStatus: "resolved",
                externalAccountRef: "provider-account-123",
              },
            ],
            products: config.providers.deepseek.catalog!.products.map((product) => ({
              ...product,
              accountRef: "renamed-local-account",
            })),
          },
        },
      },
    });
    const changedLocalMetadata = await createProductionRegistry(
      { ...changedLocalMetadataConfig, machineId: "identity-test-c" },
      { fetchFn: transport.fetchFn },
    );
    expect(
      changedLocalMetadata.accounts.find((entry) => entry.providerId === "deepseek")?.accountId,
    ).toBe(account.accountId);

    const changedExternalIdentityConfig = sharedConfigSchema.parse({
      ...changedLocalMetadataConfig,
      providers: {
        ...changedLocalMetadataConfig.providers,
        deepseek: {
          ...changedLocalMetadataConfig.providers.deepseek,
          catalog: {
            ...changedLocalMetadataConfig.providers.deepseek.catalog,
            accounts: changedLocalMetadataConfig.providers.deepseek.catalog!.accounts.map((entry) => ({
              ...entry,
              externalAccountRef: "provider-account-456",
            })),
          },
        },
      },
    });
    const changedExternalIdentity = await createProductionRegistry(
      { ...changedExternalIdentityConfig, machineId: "identity-test-d" },
      { fetchFn: transport.fetchFn },
    );
    expect(
      changedExternalIdentity.accounts.find((entry) => entry.providerId === "deepseek")?.accountId,
    ).not.toBe(
      account.accountId,
    );
  });

  it("represents unknown provider account identity as unresolved instead of synthetic defaults", async () => {
    process.env.DEEPSEEK_API_KEY = "identity-unresolved-fixture-secret";
    const config = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
        deepseek: { enabled: true },
      },
    });
    const composition = await createProductionRegistry(
      { ...config, machineId: "identity-unresolved-test" },
      { fetchFn: catalogFetch({ data: [{ id: "deepseek-chat" }] }).fetchFn },
    );

    expect(composition.accounts.filter((entry) => entry.providerId === "deepseek")).toEqual([]);
    expect(composition.products.filter((entry) => entry.providerId === "deepseek")).toEqual([]);
    const connection = composition.providerConnections
      .list()
      .find((entry) => entry.providerId === "deepseek")!;
    expect(connection.accountId).toBeUndefined();
    expect(connection.productId).toBeUndefined();

    const projection = buildRouterCatalogProjection({
      directory: composition.providerDirectory,
      accounts: composition.accounts,
      products: composition.products,
      connections: composition.providerConnections,
      modelIdentities: composition.modelIdentities,
      routeCatalog: composition.routeCatalog,
    });
    expect(projection.connections.find((entry) => entry.providerId === "deepseek")).toMatchObject({
      identityStatus: "unresolved",
    });
  });
});
