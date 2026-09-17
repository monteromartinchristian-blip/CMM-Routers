import { describe, expect, it } from "vitest";
import {
  createDefaultProviderDirectory,
} from "../../../src/usage/presentation/provider-directory.js";

describe("ProviderDirectory", () => {
  it("lists supported providers as static metadata only", () => {
    const directory = createDefaultProviderDirectory();

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

  it("reports product-safe connection methods and capabilities without adapter settings", () => {
    const directory = createDefaultProviderDirectory();

    const entry = directory.get("openrouter");
    expect(entry).toMatchObject({
      state: "available",
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

  it("includes generic OpenAI-compatible custom endpoints in the supported directory", () => {
    const directory = createDefaultProviderDirectory();
    expect(directory.get("openai-compatible")).toMatchObject({
      displayName: "Custom Endpoint",
      category: "custom_endpoint",
      connectionMethods: ["custom_endpoint"],
      state: "available",
    });
  });

  it("no longer derives state from Usage integration definitions", () => {
    const directory = createDefaultProviderDirectory();
    // Every entry returns the static default; dynamic state is joined by
    // PresentationCatalogService from the Router projection.
    for (const entry of directory.list()) {
      expect(entry.state).toBe("available");
      expect(entry.connectedInstanceCount).toBe(0);
    }
  });
});
