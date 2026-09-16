import { describe, expect, it } from "vitest";
import {
  assertSafeProviderBaseUrl,
  assertUniqueProviderManifests,
  defineProviderManifest,
  isActivatedModel,
  isPrivateOrReservedHost,
  isSafeProviderBaseUrl,
  resolveProviderBaseUrl,
  type ProviderManifest,
} from "../../src/providers/manifest.js";
import { sharedConfigSchema } from "../../src/config/schema.js";

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return defineProviderManifest({
    id: "deepseek",
    displayName: "DeepSeek API",
    billingClass: "payg",
    baseUrl: "https://api.deepseek.com/v1",
    auth: { scheme: "bearer", secretEnv: "DEEPSEEK_API_KEY" },
    discovery: { method: "GET", path: "/models" },
    apiStyles: ["openai-chat-completions"],
    toolCapability: "CHAT_AND_TOOLS",
    activation: { mode: "all", models: [] },
    ...overrides,
  });
}

describe("provider manifest contract", () => {
  it("expresses identity, billing class, base URL, auth, discovery, api style and activation", () => {
    const defined = defineProviderManifest({
      id: "qwen-token-plan",
      displayName: "Qwen Token Plan",
      billingClass: "subscription",
      baseUrl: "https://token-plan.example-region.maas.aliyuncs.com/compatible-mode/v1/",
      auth: { scheme: "bearer", secretEnv: "QWEN_TOKEN_PLAN_API_KEY" },
      discovery: { method: "GET", path: "/models" },
      apiStyles: ["openai-chat-completions"],
      toolCapability: "CHAT_AND_TOOLS",
      activation: { mode: "allowlist", models: ["qwen3-max", "qwen3-coder-plus"] },
    });

    expect(defined.id).toBe("qwen-token-plan");
    expect(defined.displayName).toBe("Qwen Token Plan");
    expect(defined.billingClass).toBe("subscription");
    // Normalized: no trailing slash, so `baseUrl + "/chat/completions"` is exact.
    expect(defined.baseUrl).toBe(
      "https://token-plan.example-region.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(defined.auth).toEqual({
      scheme: "bearer",
      secretEnv: "QWEN_TOKEN_PLAN_API_KEY",
    });
    expect(defined.discovery).toEqual({ method: "GET", path: "/models" });
    expect(defined.apiStyles).toEqual(["openai-chat-completions"]);
    expect(defined.activation).toEqual({
      mode: "allowlist",
      models: ["qwen3-max", "qwen3-coder-plus"],
    });
  });

  it("requires an explicit tool-capability declaration", () => {
    expect(manifest().toolCapability).toBe("CHAT_AND_TOOLS");
    expect(manifest({ toolCapability: "CHAT_ONLY" }).toolCapability).toBe("CHAT_ONLY");
    expect(() => manifest({ toolCapability: undefined as never })).toThrow();
    expect(() => manifest({ toolCapability: "PENDING" as never })).toThrow();
  });

  it("rejects a non-https, credential-bearing or loopback/private base URL", () => {
    for (const baseUrl of [
      "http://api.deepseek.com/v1",
      "https://user:password@api.deepseek.com/v1",
      "https://localhost/v1",
      "https://127.0.0.1:11434/v1",
      "https://10.0.0.5/v1",
      "https://192.168.1.10/v1",
      "https://172.16.4.4/v1",
      "https://169.254.169.254/v1",
      "https://[::1]/v1",
      "https://[fd00::1]/v1",
      "https://ollama.local/v1",
      "ftp://api.deepseek.com/v1",
    ]) {
      expect(
        () => assertSafeProviderBaseUrl(baseUrl),
        `${baseUrl} must be refused`,
      ).toThrow();
      expect(isSafeProviderBaseUrl(baseUrl), `${baseUrl} must not be safe`).toBe(false);
    }
    expect(isSafeProviderBaseUrl("https://api.deepseek.com/v1")).toBe(true);
  });

  it("classifies loopback, private, link-local and reserved hosts", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "ip6-localhost",
      "0.0.0.0",
      "127.0.0.1",
      "127.9.9.9",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "198.51.100.7",
      "203.0.113.7",
      "224.0.0.1",
      "255.255.255.255",
      "[::]",
      "[::1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "router.internal",
      "ollama.local",
    ]) {
      expect(isPrivateOrReservedHost(host), `${host} must be blocked`).toBe(true);
    }
    for (const host of [
      "api.deepseek.com",
      "openrouter.ai",
      "kiraai.vn",
      "integrate.api.nvidia.com",
      "ollama.com",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700::1111",
    ]) {
      expect(isPrivateOrReservedHost(host), `${host} must be allowed`).toBe(false);
    }
  });

  it("treats an unknown canonical base URL as configuration-required, never guessed", () => {
    const unresolved = manifest({ id: "qwen-cloud", baseUrl: null });
    expect(resolveProviderBaseUrl(unresolved, undefined)).toBeNull();
    expect(resolveProviderBaseUrl(unresolved, "   ")).toBeNull();
    expect(
      resolveProviderBaseUrl(
        unresolved,
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      ),
    ).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    // A configured override must obey the same host rules.
    expect(() => resolveProviderBaseUrl(unresolved, "http://127.0.0.1/v1")).toThrow();
    // A manifest default is used when no override is configured.
    expect(resolveProviderBaseUrl(manifest(), undefined)).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  it("refuses generation endpoints as the administrative discovery path", () => {
    for (const path of [
      "/chat/completions",
      "/v1/chat/completions",
      "/messages",
      "/v1/responses",
      "/generate",
      "/embeddings",
      "/images/generations",
      "models",
      "/models?live=1",
    ]) {
      expect(
        () => manifest({ discovery: { method: "GET", path } }),
        `${path} must be refused as a discovery path`,
      ).toThrow();
    }
    expect(
      defineProviderManifest({
        ...manifest(),
        discovery: { method: "GET", path: "/v1/models" },
      }).discovery.path,
    ).toBe("/v1/models");
  });

  it("refuses PAYG-fallback or malformed credential namespaces", () => {
    for (const secretEnv of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "deepseek_api_key",
      "1DEEPSEEK",
      "",
    ]) {
      expect(
        () => manifest({ auth: { scheme: "bearer", secretEnv } }),
        `${secretEnv} must be refused`,
      ).toThrow();
    }
  });

  it("refuses duplicate provider ids and duplicate credential namespaces", () => {
    expect(() => assertUniqueProviderManifests([manifest(), manifest()])).toThrow();

    const conflicting = defineProviderManifest({
      id: "vikey",
      displayName: "Vikey",
      billingClass: "api",
      baseUrl: null,
      auth: { scheme: "bearer", secretEnv: "DEEPSEEK_API_KEY" },
      discovery: { method: "GET", path: "/models" },
      apiStyles: ["openai-chat-completions"],
      toolCapability: "CHAT_ONLY",
      activation: { mode: "none", models: [] },
    });
    expect(() => assertUniqueProviderManifests([manifest(), conflicting])).toThrow();
    expect(() => assertUniqueProviderManifests([manifest()])).not.toThrow();
  });

  it("enforces the activation allowlist exactly and fails closed", () => {
    const open = manifest();
    expect(isActivatedModel(open, "any-model")).toBe(true);

    const allowlisted = manifest({
      id: "nvidia-nim",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      activation: { mode: "allowlist", models: ["moonshotai/kimi-k3"] },
    });
    expect(isActivatedModel(allowlisted, "moonshotai/kimi-k3")).toBe(true);
    expect(isActivatedModel(allowlisted, "moonshotai/KIMI-K3")).toBe(false);
    expect(isActivatedModel(allowlisted, "meta/llama-3.1-405b-instruct")).toBe(false);

    const none = manifest({ activation: { mode: "none", models: [] } });
    expect(isActivatedModel(none, "moonshotai/kimi-k3")).toBe(false);
  });
});

const LEGACY_PROVIDERS = {
  chatgpt: { enabled: false },
  claude: { enabled: false },
  google: { enabled: false },
  "command-code": {
    enabled: false,
    baseUrl: "https://api.commandcode.ai/provider/v1",
    secretEnv: "COMMAND_CODE_SECRET",
  },
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

describe("wave provider config contract", () => {
  it("expresses display name, billing class, base URL, auth scheme, discovery path, api styles and activation", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        ...LEGACY_PROVIDERS,
        kira: {
          enabled: true,
          baseUrl: "https://kiraai.vn/api/v1",
          secretEnv: "KIRA_API_KEY",
          displayName: "Kira AI",
          billingClass: "api",
          authScheme: "bearer",
          discoveryPath: "/models",
          apiStyles: ["openai-chat-completions"],
          activation: { mode: "allowlist", models: ["qwen3.8-flash-free"] },
        },
      },
    });

    expect(parsed.providers.kira).toEqual({
      enabled: true,
      baseUrl: "https://kiraai.vn/api/v1",
      secretEnv: "KIRA_API_KEY",
      displayName: "Kira AI",
      billingClass: "api",
      authScheme: "bearer",
      discoveryPath: "/models",
      apiStyles: ["openai-chat-completions"],
      activation: { mode: "allowlist", models: ["qwen3.8-flash-free"] },
    });
  });

  it("rejects a provider entry that points at a foreign credential namespace or a generation discovery path", () => {
    const base = {
      mode: "standalone",
      host: "127.0.0.1",
      providers: LEGACY_PROVIDERS,
    };
    expect(
      sharedConfigSchema.safeParse({
        ...base,
        providers: {
          ...LEGACY_PROVIDERS,
          deepseek: {
            enabled: true,
            baseUrl: "https://api.deepseek.com/v1",
            secretEnv: "OPENAI_API_KEY",
          },
        },
      }).success,
    ).toBe(false);

    expect(
      sharedConfigSchema.safeParse({
        ...base,
        providers: {
          ...LEGACY_PROVIDERS,
          deepseek: {
            enabled: true,
            baseUrl: "https://api.deepseek.com/v1",
            secretEnv: "DEEPSEEK_API_KEY",
            discoveryPath: "/chat/completions",
          },
        },
      }).success,
    ).toBe(false);

    expect(
      sharedConfigSchema.safeParse({
        ...base,
        providers: {
          ...LEGACY_PROVIDERS,
          deepseek: {
            enabled: true,
            baseUrl: "https://127.0.0.1/v1",
            secretEnv: "DEEPSEEK_API_KEY",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("defaults every wave provider to disabled with its own credential namespace", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: LEGACY_PROVIDERS,
    });

    for (const [id, secretEnv] of WAVE_CREDENTIALS) {
      const entry = (
        parsed.providers as unknown as Record<
          string,
          { enabled: boolean; secretEnv?: string } | undefined
        >
      )[id];
      expect(entry, `${id} must default into the config`).toBeDefined();
      expect(entry!.enabled, `${id} must default disabled`).toBe(false);
      expect(entry!.secretEnv, `${id} credential namespace`).toBe(secretEnv);
    }
  });

  it("keeps the three subscription bridges and the existing wave routes unchanged", () => {
    const parsed = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
      providers: {
        chatgpt: { enabled: true, codexHome: "/tmp/codex" },
        claude: { enabled: true, profileDir: "/tmp/claude" },
        google: { enabled: true, agyPath: "/tmp/agy" },
        "command-code": {
          enabled: false,
          baseUrl: "https://api.commandcode.ai/provider/v1",
          secretEnv: "COMMAND_CODE_SECRET",
        },
        cavoti: {
          enabled: false,
          baseUrl: "https://cavoti.com/v1",
          secretEnv: "CAVOTI_API_KEY",
          model: "deepseek-v4.1-flash",
        },
      },
    });

    expect(parsed.providers.chatgpt).toEqual({ enabled: true, codexHome: "/tmp/codex" });
    expect(parsed.providers.claude).toEqual({ enabled: true, profileDir: "/tmp/claude" });
    expect(parsed.providers.google).toEqual({ enabled: true, agyPath: "/tmp/agy" });
    expect(parsed.providers["command-code"]).toEqual({
      enabled: false,
      baseUrl: "https://api.commandcode.ai/provider/v1",
      secretEnv: "COMMAND_CODE_SECRET",
    });
    expect(parsed.providers.cavoti).toEqual({
      enabled: false,
      baseUrl: "https://cavoti.com/v1",
      secretEnv: "CAVOTI_API_KEY",
      model: "deepseek-v4.1-flash",
    });
  });
});
