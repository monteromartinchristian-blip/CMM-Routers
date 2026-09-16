import { describe, expect, it } from "vitest";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { catalogFetch, routerRequest, sseFetch, waveAdapter } from "../helpers/wave-fixtures.js";
import type { RouterEvent } from "../../src/core/events.js";

/** Cline catalog fixture. */
const CLINE_CATALOG = {
  data: [
    { id: "cline/claude-sonnet-4-5", name: "Claude Sonnet 4.5 (Cline)" },
    { id: "cline/deepseek-v4", name: "DeepSeek V4 (Cline)" },
  ],
};

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Cline API / ClinePass", () => {
  it("registers Cline as an API provider, not as promotional IDE/CLI free models", () => {
    const manifest = providerWaveManifest("cline");

    expect(manifest.id).toBe("cline");
    expect(manifest.displayName).toBe("Cline API / ClinePass");
    expect(manifest.billingClass).toBe("payg");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "CLINE_API_KEY" });
    expect(manifest.baseUrl).toBe("https://api.cline.bot/api/v1");
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
    expect(manifest.activation).toEqual({ mode: "all", models: [] });
  });

  it("discovers the account's own catalog instead of a promotional model list", async () => {
    const { fetchFn, requests } = catalogFetch(CLINE_CATALOG);
    const adapter = waveAdapter("cline", { fetchFn });

    const models = await adapter.discoverModels();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.cline.bot/api/v1/models");
    expect(models.map((model) => model.upstreamModel)).toEqual([
      "cline/claude-sonnet-4-5",
      "cline/deepseek-v4",
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "cline/cline/claude-sonnet-4-5",
      "cline/cline/deepseek-v4",
    ]);
  });

  it("streams text and tool calls through the generic router path it supports", async () => {
    const streaming = sseFetch([
      { choices: [{ delta: { role: "assistant", content: "Cline " } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_cline_1",
                  type: "function",
                  function: { name: "calculator", arguments: "{\"a\":1}" },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const adapter = waveAdapter("cline", { fetchFn: streaming.fetchFn });
    const { request, signal } = routerRequest("cline", "cline/deepseek-v4", {
      tools: [
        {
          type: "function",
          function: { name: "calculator", parameters: { type: "object" } },
        },
      ],
    });

    const events = await collect(adapter.run(request, signal));

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Cline " },
    ]);
    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      {
        type: "tool_call_delta",
        index: 0,
        id: "call_cline_1",
        name: "calculator",
        argumentsDelta: "{\"a\":1}",
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "tool_calls" });
    expect(streaming.requests[0]!.url).toBe("https://api.cline.bot/api/v1/chat/completions");
    expect(streaming.requests[0]!.body?.model).toBe("cline/deepseek-v4");
  });

  it("requires its own credential namespace", () => {
    expect(providerWaveManifest("cline").auth.secretEnv).toBe("CLINE_API_KEY");
  });
});
