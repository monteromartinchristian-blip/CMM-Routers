import { describe, expect, it } from "vitest";
import { ProviderDirectory } from "../../src/catalog/provider-directory.js";
import type { ProviderDefinition } from "../../src/catalog/types.js";
import {
  PROVIDER_WAVE_MANIFESTS,
  providerDefinitions,
} from "../../src/providers/manifests.js";

const DEEPSEEK_DEFINITION: ProviderDefinition = {
  providerId: "deepseek",
  displayName: "DeepSeek API",
  adapterKind: "openai-compatible",
  supportedConnectionKinds: ["openai-chat-completions"],
  discoveryCapabilities: ["models"],
};

const EXPECTED_WAVE_PROVIDER_IDS = [
  "qwen-token-plan",
  "qwen-cloud",
  "deepseek",
  "openrouter",
  "opencode-zen",
  "kira",
  "nvidia-nim",
  "vikey",
  "cline",
  "ollama-cloud",
  "command-code",
  "cavoti",
] as const;

describe("ProviderDirectory", () => {
  it("rejects duplicate provider IDs instead of shadowing the first definition", () => {
    const directory = new ProviderDirectory();
    directory.register(DEEPSEEK_DEFINITION);

    expect(() =>
      directory.register({
        ...DEEPSEEK_DEFINITION,
        displayName: "Replacement",
      }),
    ).toThrow(/duplicate provider id.*deepseek/i);
    expect(directory.get("deepseek")).toBe(DEEPSEEK_DEFINITION);
  });

  it("looks up known providers and reports unknown providers without inventing definitions", () => {
    const directory = new ProviderDirectory();
    directory.register(DEEPSEEK_DEFINITION);

    expect(directory.has("deepseek")).toBe(true);
    expect(directory.get("deepseek")).toBe(DEEPSEEK_DEFINITION);
    expect(directory.has("unknown-provider")).toBe(false);
    expect(directory.get("unknown-provider")).toBeUndefined();
    expect(directory.list()).toEqual([DEEPSEEK_DEFINITION]);
  });
});

describe("provider manifest projection", () => {
  it("contains only provider metadata and excludes credentials, billing, quotas and balances", () => {
    const definitions = providerDefinitions();
    const allowedKeys = [
      "adapterKind",
      "discoveryCapabilities",
      "displayName",
      "providerId",
      "supportedConnectionKinds",
    ];

    for (const definition of definitions) {
      expect(Object.keys(definition).sort(), definition.providerId).toEqual(allowedKeys);
    }

    const serialized = JSON.stringify(definitions);
    expect(serialized).not.toMatch(
      /credentialEnv|secretEnv|apiKey|billingClass|quota|balance|COMMAND_CODE_SECRET|_API_KEY/i,
    );
  });

  it("represents every current wave provider ID exactly once", () => {
    const manifestIds = PROVIDER_WAVE_MANIFESTS.map((manifest) => manifest.id);
    const definitionIds = providerDefinitions().map((definition) => definition.providerId);

    expect(manifestIds).toEqual(EXPECTED_WAVE_PROVIDER_IDS);
    expect(definitionIds).toEqual(EXPECTED_WAVE_PROVIDER_IDS);
    expect(new Set(definitionIds).size).toBe(EXPECTED_WAVE_PROVIDER_IDS.length);
  });
});
