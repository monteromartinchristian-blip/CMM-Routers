import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultUsageIntegrationCatalog,
  type SecureCredentialResolver,
} from "../../../src/usage/runtime/integration-catalog.js";

describe("default CMM Usage integration catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires every completed canonical provider integration without resolving credentials at construction", () => {
    let resolutions = 0;
    const resolver: SecureCredentialResolver = {
      resolve: async () => {
        resolutions += 1;
        return "secret";
      },
    };
    const catalog = createDefaultUsageIntegrationCatalog(resolver);

    expect(catalog.types()).toEqual([
      "chatgpt-subscription",
      "claude-subscription",
      "command-code",
      "deepseek",
      "google-ai-pro",
      "openai-api",
      "openai-compatible",
      "openrouter",
      "qwen-payg",
      "qwen-token-plan",
    ]);

    const definitions = [
      { id: "command", type: "command-code", enabled: true, credentialRef: "env://COMMAND", settings: {} },
      { id: "claude", type: "claude-subscription", enabled: true, credentialRef: "env://CLAUDE", settings: {} },
      { id: "openai", type: "openai-api", enabled: true, credentialRef: "env://OPENAI", settings: {} },
      { id: "chatgpt", type: "chatgpt-subscription", enabled: true, credentialRef: "env://CHATGPT", settings: { accountId: "workspace-1" } },
      { id: "google", type: "google-ai-pro", enabled: true, credentialRef: "env://GOOGLE", settings: {} },
      { id: "deepseek", type: "deepseek", enabled: true, credentialRef: "env://DEEPSEEK", settings: {} },
      { id: "qwen-plan", type: "qwen-token-plan", enabled: true, credentialRef: "env://QWEN_PLAN", settings: { baseUrl: "https://token-plan.example/v1", plan: { edition: "personal" } } },
      { id: "qwen-payg", type: "qwen-payg", enabled: true, credentialRef: "env://QWEN_PAYG", settings: { baseUrl: "https://dashscope.example/v1" } },
      { id: "openrouter", type: "openrouter", enabled: true, credentialRef: "env://OPENROUTER", settings: {} },
      { id: "custom", type: "openai-compatible", enabled: true, settings: { name: "Custom", baseUrl: "https://example.com/v1", discoverModels: false } },
    ] as const;

    for (const definition of definitions) expect(catalog.create(definition).manifest().collectionSafety).toBe("non_inference_only");
    expect(resolutions).toBe(0);
  });

  it("requires secure credential references for credentialed integrations", () => {
    const catalog = createDefaultUsageIntegrationCatalog({ resolve: async () => undefined });

    expect(() => catalog.create({ id: "deepseek", type: "deepseek", enabled: true, settings: {} })).toThrow(/credential/i);
  });

  it("targets the current Command Code API root for metadata collection", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      seen.push(url.toString());
      let body: unknown = {};
      if (url.pathname.endsWith("/alpha/whoami")) body = { org: { id: "org-1" }, orgLimits: [] };
      if (url.pathname.endsWith("/alpha/billing/credits")) body = { credits: {}, windowLimits: {} };
      if (url.pathname.endsWith("/alpha/billing/subscriptions")) body = { data: {} };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const catalog = createDefaultUsageIntegrationCatalog({ resolve: async () => "test-command-key" });
    const adapter = catalog.create({
      id: "command",
      type: "command-code",
      enabled: true,
      credentialRef: "env://COMMAND",
      settings: {},
    });

    expect((await adapter.discover()).status).toBe("ok");
    expect(seen.map((value) => new URL(value).pathname)).toEqual([
      "/alpha/whoami",
      "/alpha/billing/credits",
      "/alpha/billing/subscriptions",
      "/alpha/usage/summary",
    ]);
    expect(seen.every((value) => new URL(value).origin === "https://api.commandcode.ai")).toBe(true);
  });
});
