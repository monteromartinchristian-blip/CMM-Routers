import { describe, expect, it } from "vitest";
import { sharedConfigSchema, localConfigSchema } from "../../src/config/schema.js";

describe("config schema", () => {
  it("rejects non-loopback hosts in standalone mode", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "0.0.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("accepts loopback host", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
    });
    expect(result.success).toBe(true);
  });

  it("uses default port 8790 when not specified", () => {
    const result = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
    });
    expect(result.port).toBe(8790);
  });

  it("rejects local config with secret-like keys", () => {
    const result = localConfigSchema.safeParse({
      apiKey: "secret-value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects local config with oauth tokens", () => {
    const result = localConfigSchema.safeParse({
      oauthToken: "token-value",
    });
    expect(result.success).toBe(false);
  });

  it("accepts local config with only safe keys", () => {
    const result = localConfigSchema.safeParse({
      machineId: "macbook-pro",
      profiles: { claude: "router-profile" },
    });
    expect(result.success).toBe(true);
  });

  // Remediation 1: Comprehensive fail-closed regression tests
  it("rejects shared.providers.chatgpt.apiKey", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: true, apiKey: "sk-test" },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects shared.providers.claude.oauthToken", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: true, oauthToken: "token" },
        google: { enabled: false },
        "command-code": { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects shared.providers.google.accessToken", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: true, accessToken: "ya29..." },
        "command-code": { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects shared.providers.command-code.secret", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: false },
        claude: { enabled: false },
        google: { enabled: false },
        "command-code": { enabled: true, secret: "cmd-secret" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level shared key", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown local key", () => {
    const result = localConfigSchema.safeParse({
      machineId: "test",
      unknownLocalField: "value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects secret-like nested configuration in arrays", () => {
    const result = localConfigSchema.safeParse({
      machineId: "test",
      credentials: [{ apiKey: "secret" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects secret-like key inside nested object", () => {
    const result = localConfigSchema.safeParse({
      machineId: "test",
      nested: { refreshToken: "token" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid approved configuration", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      port: 8790,
      bearerSecretEnv: "CMM_ROUTER_TOKEN",
      providers: {
        chatgpt: { enabled: true, codexHome: "/path/to/codex" },
        claude: { enabled: true, profileDir: "/path/to/profile" },
        google: { enabled: true, agyPath: "/usr/bin/agy" },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
