import { describe, expect, it } from "vitest";
import {
  createDefaultProviderDirectory,
} from "../../../src/usage/presentation/provider-directory.js";

describe("ProviderDirectory", () => {
  it("lists supported providers even when none are configured", () => {
    const directory = createDefaultProviderDirectory([]);

    expect(directory.list().map((entry) => entry.integrationType)).toEqual(
      expect.arrayContaining([
        "command-code",
        "chatgpt-subscription",
        "claude-subscription",
        "google-ai-pro",
        "deepseek",
        "openai-api",
        "openrouter",
        "qwen-token-plan",
        "qwen-payg",
      ]),
    );
    expect(directory.get("openrouter")).toMatchObject({
      displayName: "OpenRouter",
      category: "aggregator",
      state: "available",
      connectedInstanceCount: 0,
    });
  });

  it("separates supported, connected, enabled and healthy state", () => {
    const directory = createDefaultProviderDirectory([
      { id: "cc", type: "command-code", enabled: false, settings: {} },
    ]);

    expect(directory.get("command-code")).toMatchObject({
      state: "disabled",
      connectedInstanceCount: 1,
    });
    expect(directory.get("openrouter")).toMatchObject({
      state: "available",
      connectedInstanceCount: 0,
    });
  });

  it("reports product-safe connection methods and capabilities without adapter settings", () => {
    const directory = createDefaultProviderDirectory([
      {
        id: "router-live",
        type: "openrouter",
        enabled: true,
        credentialRef: "env://OPENROUTER",
        settings: { baseUrl: "https://example.invalid", internalOnly: "secretish" },
      },
    ]);

    const entry = directory.get("openrouter");
    expect(entry).toMatchObject({
      state: "connected",
      connectionMethods: ["api_key"],
      capabilities: {
        modelDiscovery: true,
        quotaDiscovery: true,
        balanceDiscovery: true,
        costDiscovery: false,
        pricingDiscovery: false,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("credentialRef");
    expect(JSON.stringify(entry)).not.toContain("baseUrl");
    expect(JSON.stringify(entry)).not.toContain("internalOnly");
  });

  it("updates connected state and safe instance handles after runtime connection changes", () => {
    const directory = createDefaultProviderDirectory([]);

    expect(directory.instanceIds("openrouter")).toEqual([]);
    directory.replaceDefinitions([
      {
        id: "openrouter-primary",
        type: "openrouter",
        enabled: true,
        credentialRef: "keychain://CMM%20Usage/openrouter-primary",
        settings: { baseUrl: "https://example.invalid", privateSetting: "do-not-expose" },
      },
    ]);

    expect(directory.get("openrouter")).toMatchObject({ state: "connected", connectedInstanceCount: 1 });
    expect(directory.instanceIds("openrouter")).toEqual(["openrouter-primary"]);
    expect(JSON.stringify(directory.list())).not.toContain("credentialRef");
    expect(JSON.stringify(directory.list())).not.toContain("privateSetting");

    directory.replaceDefinitions([]);
    expect(directory.get("openrouter")).toMatchObject({ state: "available", connectedInstanceCount: 0 });
    expect(directory.instanceIds("openrouter")).toEqual([]);
  });

  it("includes generic OpenAI-compatible custom endpoints in the supported directory", () => {
    const directory = createDefaultProviderDirectory([]);
    expect(directory.get("openai-compatible")).toMatchObject({
      displayName: "Custom Endpoint",
      category: "custom_endpoint",
      connectionMethods: ["custom_endpoint"],
      state: "available",
    });
  });
});
