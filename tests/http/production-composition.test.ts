import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionRegistry, createProductionServer } from "../../src/index.js";
import { createProductionUsageRuntime } from "../../src/usage/runtime/production-runtime.js";
import { UsageIntegrationCatalog } from "../../src/usage/runtime/configured-runtime.js";

describe("production composition root", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-prod-"));
    process.env = { ...savedEnv };
    delete process.env.COMMAND_CODE_SECRET;
    delete process.env.CMM_TEST_PROVIDER;
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(overrides: Record<string, unknown> = {}) {
    const shared = {
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers: {
        chatgpt: { enabled: true },
        claude: { enabled: true },
        google: { enabled: true },
        "command-code": {
          enabled: true,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
      ...overrides,
    };
    writeFileSync(join(dir, "shared.json"), JSON.stringify(shared));
    writeFileSync(join(dir, "local.json"), JSON.stringify({}));
  }

  it("registers chatgpt, claude, google from the same factory index.ts uses", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    expect(composition.registeredProviders).toContain("chatgpt");
    expect(composition.registeredProviders).toContain("claude");
    expect(composition.registeredProviders).toContain("google");
    console.log(
      `PRODUCTION_REGISTERED_PROVIDER_COUNT=${composition.registeredProviders.length}`,
    );
    expect(composition.registeredProviders.length).toBeGreaterThanOrEqual(3);
  });

  it("skips command-code without ack instead of registering insecurely", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    expect(composition.registeredProviders).not.toContain("command-code");
    expect(
      composition.skippedProviders.some((s) => s.id === "command-code"),
    ).toBe(true);
  });

  it("does not instantiate disabled providers", { timeout: 60000 }, async () => {
    writeConfig({
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: true },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
    });
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    expect(composition.registeredProviders).toEqual(["google"]);
  });

  it("production-composed /v1/models returns provider models", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    const server = createProductionServer(composition, "composition-test-secret");
    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer composition-test-secret" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("wires the live production catalog into the management endpoint", async () => {
    process.env.CMM_TEST_PROVIDER = "scripted";
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    const server = createProductionServer(composition, "composition-test-secret");

    const response = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: { authorization: "Bearer composition-test-secret" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers).toContainEqual({
      providerId: "chatgpt",
      displayName: "ChatGPT / Codex",
    });
    expect(body.accounts).toEqual([]);
    expect(body.products).toEqual([]);
    expect(body.connections).toContainEqual(
      expect.objectContaining({
        providerId: "chatgpt",
        identityStatus: "unresolved",
      }),
    );
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({
      providerId: "chatgpt",
      providerModelId: "scripted-test-model",
      routable: true,
    });
  });

  it("exposes router administration over the canonical production catalog", async () => {
    process.env.CMM_TEST_PROVIDER = "scripted";
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    // `catalogReconcileIntervalMs: 0` disables the 30s refresh throttle so the
    // read path below reconciles for real. With the production default the
    // read would be skipped, which hides whether an accepted admin visibility
    // write survives reconciliation.
    const composition = await createProductionRegistry(loadConfig(dir), {
      configDir: dir,
      catalogReconcileIntervalMs: 0,
    });
    const usage = await createProductionUsageRuntime({
      configDir: dir,
      databasePath: ":memory:",
      catalog: new UsageIntegrationCatalog(),
    });
    const server = createProductionServer(composition, "composition-test-secret", undefined, {
      service: usage.runtime.service,
      token: "usage-read-only",
      managementToken: "router-administration",
    });

    const before = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: { authorization: "Bearer composition-test-secret" },
    });
    expect(before.statusCode).toBe(200);
    const route = before.json().routes[0] as {
      routeId: string;
      visibility: { visibleOn: string[] };
    };
    expect(composition.routerAdministration).toBeDefined();
    expect(composition.routeCatalog.get(route.routeId)).toBeDefined();

    const mutation = await server.inject({
      method: "PATCH",
      url: `/v1/cmm/catalog/routes/${encodeURIComponent(route.routeId)}/visibility`,
      headers: {
        authorization: "Bearer router-administration",
        "content-type": "application/json",
      },
      payload: { visibleOn: ["admin_console"] },
    });
    expect(mutation.statusCode).toBe(200);
    expect(mutation.body).not.toMatch(/secret|keychain/i);

    // The privileged handler must mutate the same canonical graph the read
    // projection and execution path use, never a second Router state graph.
    expect(composition.routeCatalog.get(route.routeId)?.visibility.visibleOn).toEqual([
      "admin_console",
    ]);
    const after = await server.inject({
      method: "GET",
      url: "/v1/cmm/catalog",
      headers: { authorization: "Bearer composition-test-secret" },
    });
    expect(after.statusCode).toBe(200);
    const afterRoute = after.json().routes[0] as {
      routeId: string;
      visibility: { visibleOn: string[] };
    };
    expect(afterRoute.routeId).toBe(route.routeId);
    expect(afterRoute.visibility.visibleOn).toEqual(["admin_console"]);
    expect(composition.routeCatalog.get(route.routeId)?.visibility.visibleOn).toEqual([
      "admin_console",
    ]);

    await server.close();
    await usage.close();
  });

  it("/ready reflects provider health", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    const server = createProductionServer(composition, "composition-test-secret");
    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect([200, 503]).toContain(ready.statusCode);
  });

  it("wires the production CMM Usage service behind its scoped read-only credential", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    const usage = await createProductionUsageRuntime({
      configDir: dir,
      databasePath: ":memory:",
      catalog: new UsageIntegrationCatalog(),
    });
    const server = createProductionServer(
      composition,
      "composition-test-secret",
      undefined,
      { service: usage.runtime.service, token: "usage-read-only" },
    );

    const usageResponse = await server.inject({
      method: "GET",
      url: "/v1/cmm/usage",
      headers: { authorization: "Bearer usage-read-only" },
    });
    expect(usageResponse.statusCode).toBe(200);
    expect(usageResponse.json()).toMatchObject({ providerCount: 0, quotaCount: 0 });

    const inferenceResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer usage-read-only", "content-type": "application/json" },
      payload: { model: "anything", messages: [{ role: "user", content: "hi" }] },
    });
    expect(inferenceResponse.statusCode).toBe(403);

    await server.close();
    await usage.close();
  });
});
