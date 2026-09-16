import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import {
  GENERIC_WAVE_MANIFESTS,
  providerWaveManifest,
} from "../../src/providers/manifests.js";
import { isActivatedModel } from "../../src/providers/manifest.js";
import { catalogFetch, routerRequest, sseFetch, waveAdapter } from "../helpers/wave-fixtures.js";
import type { RouterEvent } from "../../src/core/events.js";

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const DEEPSEEK_CATALOG = {
  data: [
    { id: "deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
  ],
};

const OPENROUTER_CATALOG = {
  data: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "openai/gpt-5-codex", name: "GPT-5 Codex" },
  ],
};

const ZEN_CATALOG = {
  data: [{ id: "zen-coder-flash", name: "Zen Coder Flash" }],
};

describe("DeepSeek, OpenRouter and OpenCode Zen manifests", () => {
  it("registers one manifest per provider with its own identity and credential namespace", () => {
    const expected = {
      deepseek: {
        displayName: "DeepSeek API",
        billingClass: "payg",
        secretEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com/v1",
      },
      openrouter: {
        displayName: "OpenRouter",
        billingClass: "payg",
        secretEnv: "OPENROUTER_API_KEY",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      "opencode-zen": {
        displayName: "OpenCode Zen",
        billingClass: "payg",
        secretEnv: "OPENCODE_ZEN_API_KEY",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    } as const;

    for (const [id, fields] of Object.entries(expected)) {
      const manifest = providerWaveManifest(id as keyof typeof expected);
      expect(manifest.displayName).toBe(fields.displayName);
      expect(manifest.billingClass).toBe(fields.billingClass);
      expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: fields.secretEnv });
      expect(manifest.baseUrl).toBe(fields.baseUrl);
      expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
      expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
      expect(manifest.toolCapability).toBe("CHAT_AND_TOOLS");
    }
  });

  it("keeps discovery authoritative instead of hardcoding a model catalog", () => {
    for (const id of ["deepseek", "openrouter", "opencode-zen"] as const) {
      const manifest = providerWaveManifest(id);
      expect(manifest.activation.mode).toBe("all");
      expect(manifest.activation.models).toEqual([]);
      expect(isActivatedModel(manifest, "any-model-the-provider-lists")).toBe(true);
    }
  });

  it("serves all three providers from the single generic adapter", () => {
    const adapters = ["deepseek", "openrouter", "opencode-zen"].map((id) =>
      waveAdapter(id as "deepseek"),
    );
    const constructors = new Set(adapters.map((adapter) => adapter.constructor));
    expect(constructors.size).toBe(1);
    expect([...constructors][0]!.name).toBe("OpenAiCompatibleAdapter");
    const manifestIds = GENERIC_WAVE_MANIFESTS.map((manifest) => manifest.id);
    for (const id of ["deepseek", "openrouter", "opencode-zen"]) {
      expect(manifestIds).toContain(id);
    }
  });

  it("discovers each provider's exact model ids through its own route namespace", async () => {
    const fixtures: Array<[string, unknown]> = [
      ["deepseek", DEEPSEEK_CATALOG],
      ["openrouter", OPENROUTER_CATALOG],
      ["opencode-zen", ZEN_CATALOG],
    ];
    for (const [id, catalog] of fixtures) {
      const adapter = waveAdapter(id as "deepseek", { catalog });
      const models = await adapter.discoverModels();
      const upstreamIds = (catalog as { data: Array<{ id: string }> }).data.map(
        (entry) => entry.id,
      );
      expect(models.map((model) => model.upstreamModel)).toEqual(upstreamIds);
      expect(models.map((model) => model.id)).toEqual(
        upstreamIds.map((upstreamId) => `${id}/${upstreamId}`),
      );
      expect(models.every((model) => model.provider === id)).toBe(true);
    }
  });

  it("routes a discovery result end to end with an injected transport", async () => {
    const registry = new ProviderRegistry();
    const discovery = catalogFetch(OPENROUTER_CATALOG);
    await registry.register(waveAdapter("openrouter", { fetchFn: discovery.fetchFn }));

    const model = await registry.resolve("openrouter/google/gemini-2.5-pro");
    expect(model.upstreamModel).toBe("google/gemini-2.5-pro");
    expect(discovery.requests).toHaveLength(1);
    expect(discovery.requests[0]!.url).toBe("https://openrouter.ai/api/v1/models");

    const streaming = sseFetch([
      { choices: [{ delta: { role: "assistant", content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const adapter = waveAdapter("openrouter", { fetchFn: streaming.fetchFn });
    const { request, signal } = routerRequest("openrouter", "google/gemini-2.5-pro");

    const events = await collect(adapter.run(request, signal));

    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
    expect(streaming.requests).toHaveLength(1);
    expect(streaming.requests[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(streaming.requests[0]!.body?.model).toBe("google/gemini-2.5-pro");
  });
});
