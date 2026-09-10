import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import type { RouterRequest } from "../../src/core/model.js";

const seen: RouterRequest[] = [];

function captureAdapter(id: "command-code" | "chatgpt"): ProviderAdapter {
  return {
    id,
    async discoverModels() {
      return [
        {
          id: `${id}/m`,
          provider: id,
          upstreamModel: "m",
          displayName: "m",
          capability: "CHAT_AND_TOOLS",
        },
      ];
    },
    async health() {
      return { status: "ready" };
    },
    async *run(request) {
      seen.push(request);
      yield { type: "completed", finishReason: "stop" };
    },
    async cancel() {},
  };
}

describe("tool_choice / parallel_tool_calls", () => {
  it("preserves tool_choice and parallel_tool_calls in the provider request", async () => {
    seen.length = 0;
    const registry = new ProviderRegistry();
    await registry.register(captureAdapter("command-code"));
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "c",
      qoderToken: "q",
      registry,
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "command-code/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        tool_choice: "required",
        parallel_tool_calls: false,
      },
    });
    expect(res.statusCode).toBe(200);
    // RouterRequest.toolChoice carries the API-independent NORMALIZED policy;
    // each HTTP boundary parses its own wire shape into this form.
    expect(seen[0]!.toolChoice).toEqual({ kind: "required" });
    expect(seen[0]!.parallelToolCalls).toBe(false);
    console.log("TOOL_CHOICE_PRESERVED=PASS");
  });

  it("fails closed on forced tool_choice for Codex without representation", async () => {
    const registry = new ProviderRegistry();
    await registry.register(captureAdapter("chatgpt"));
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "c",
      qoderToken: "q",
      registry,
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "chatgpt/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        tool_choice: { type: "function", function: { name: "t" } },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
