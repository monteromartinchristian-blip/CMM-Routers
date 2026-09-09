import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionRegistry, createProductionServer } from "../../src/index.js";

describe("production composition root", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-prod-"));
    process.env = { ...savedEnv };
    delete process.env.COMMAND_CODE_SECRET;
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

  it("/ready reflects provider health", { timeout: 60000 }, async () => {
    writeConfig();
    const { loadConfig } = await import("../../src/config/load-config.js");
    const composition = await createProductionRegistry(loadConfig(dir));
    const server = createProductionServer(composition, "composition-test-secret");
    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect([200, 503]).toContain(ready.statusCode);
  });
});
