import { describe, expect, it } from "vitest";
import { sharedConfigSchema, localConfigSchema } from "../../src/config/schema.js";

describe("config schema", () => {
  it.each(["apiKey", "accessToken", "secret", "cookie", "oauthToken", "refreshToken"])(
    "rejects raw Router administrative credential field %s",
    (field) => {
      const result = sharedConfigSchema.safeParse({
        mode: "standalone",
        host: "127.0.0.1",
        administrativeConnections: [{
          connectionId: "connection:openrouter:primary",
          providerId: "openrouter",
          connectionKind: "openai-chat-completions",
          executionSecretRef: "keychain://CMM%20Usage/openrouter-primary",
          enabled: true,
          [field]: "raw-secret-value",
        }],
      });

      expect(result.success).toBe(false);
    },
  );

  it("accepts Router administrative records containing secure references only", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      administrativeConnections: [{
        connectionId: "connection:openrouter:primary",
        providerId: "openrouter",
        accountId: "account:primary",
        productId: "product:api",
        connectionKind: "openai-chat-completions",
        executionSecretRef: "keychain://CMM%20Usage/openrouter-primary",
        observabilitySecretRef: "keychain://CMM%20Usage/openrouter-observability",
        profileRef: "profile:openrouter:primary",
        endpointRef: "endpoint:openrouter:primary",
        enabled: true,
      }],
    });

    expect(result.success).toBe(true);
  });

  it.each([
    "env://OPENROUTER_API_KEY",
    "https://user:raw-secret@example.com/credential",
    "https://example.com/credential?apiKey=raw-secret",
    "keychain://CMM%20Usage/openrouter-primary?secret=raw-secret",
    "keychain://CMM%20Usage/openrouter-primary#raw-secret",
    "keychain://Other%20Service/openrouter-primary",
  ])("rejects unsupported or credential-bearing Router secret ref %s", (secretRef) => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      administrativeConnections: [{
        connectionId: "connection:openrouter:primary",
        providerId: "openrouter",
        connectionKind: "openai-chat-completions",
        executionSecretRef: secretRef,
        enabled: true,
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects raw values placed in Router secretRef fields", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      administrativeConnections: [{
        connectionId: "connection:openrouter:primary",
        providerId: "openrouter",
        connectionKind: "openai-chat-completions",
        executionSecretRef: "raw-secret-value",
        enabled: true,
      }],
    });

    expect(result.success).toBe(false);
  });

  it("keeps canonical routeVisibility writable state exact-route only", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
      routeVisibility: [
        {
          providerId: "test-provider",
          providerModelId: "provider/model-a",
          visibleOn: [],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

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
        "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
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

  it("accepts explicit provider catalog topology with one primary runtime connection", () => {
    const result = sharedConfigSchema.safeParse({
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
                ref: "team-a",
                label: "Team A",
                identityStatus: "resolved",
                externalAccountRef: "provider-account-123",
              },
            ],
            products: [
              {
                ref: "api-primary",
                accountRef: "team-a",
                kind: "api",
                label: "Primary API",
              },
              {
                ref: "api-secondary",
                accountRef: "team-a",
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

    expect(result.success).toBe(true);
  });

  it("rejects invalid provider catalog identity topology fail closed", () => {
    const providerBase = {
      enabled: true,
      catalog: {
        accounts: [
          {
            ref: "team-a",
            label: "Team A",
            identityStatus: "resolved",
            externalAccountRef: "provider-account-123",
          },
        ],
        products: [
          {
            ref: "api-primary",
            accountRef: "team-a",
            kind: "api",
            label: "Primary API",
          },
        ],
        connections: [
          { ref: "primary", productRef: "api-primary", runtime: "primary" },
        ],
      },
    };
    const parseProvider = (deepseek: unknown) =>
      sharedConfigSchema.safeParse({
        mode: "standalone",
        host: "127.0.0.1",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
          deepseek,
        },
      }).success;

    expect(
      parseProvider({
        ...providerBase,
        catalog: {
          ...providerBase.catalog,
          accounts: [
            { ref: "team-a", label: "Team A", identityStatus: "resolved" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parseProvider({
        ...providerBase,
        catalog: {
          ...providerBase.catalog,
          accounts: [
            {
              ref: "team-a",
              label: "Team A",
              identityStatus: "unresolved",
              externalAccountRef: "provider-account-123",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parseProvider({
        ...providerBase,
        catalog: {
          ...providerBase.catalog,
          products: [
            {
              ref: "api-primary",
              accountRef: "missing-account",
              kind: "api",
              label: "Primary API",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parseProvider({
        ...providerBase,
        catalog: {
          ...providerBase.catalog,
          connections: [
            { ref: "primary-a", productRef: "api-primary", runtime: "primary" },
            { ref: "primary-b", productRef: "api-primary", runtime: "primary" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parseProvider({
        ...providerBase,
        catalog: {
          ...providerBase.catalog,
          accounts: [
            {
              ref: "team-a",
              label: "Team A",
              identityStatus: "resolved",
              externalAccountRef: "provider-account-123",
              apiKey: "secret-must-not-be-accepted",
            },
          ],
        },
      }),
    ).toBe(false);
  });
});
