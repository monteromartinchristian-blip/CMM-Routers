import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const BEARER = "chat-only-test-secret";
const QODER_BEARER = "chat-only-qoder-secret";

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

class ChatOnlyProvider implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/chat-only-model",
        provider: "chatgpt",
        upstreamModel: "chat-only-model",
        displayName: "Chat Only Model",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

class ToolsCapableProvider implements ProviderAdapter {
  readonly id: "claude" = "claude";
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/tools-model",
        provider: "claude",
        upstreamModel: "tools-model",
        displayName: "Tools Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

describe("CHAT_ONLY capability enforcement at the HTTP boundary", () => {
  let registry: ProviderRegistry;
  let chatOnly: ChatOnlyProvider;
  let capable: ToolsCapableProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    chatOnly = new ChatOnlyProvider();
    capable = new ToolsCapableProvider();
    await registry.register(chatOnly);
    await registry.register(capable);
    await registry.refresh();
  });

  it("rejects chat completions with tools on CHAT_ONLY before provider run", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(chatOnly.invocations).toBe(0);
    console.log("CHAT_ONLY_CHAT_COMPLETIONS_REJECTION=PASS");
  });

  it("rejects responses with tools on CHAT_ONLY before provider run", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        input: "hi",
        tools: [{ type: "function", name: "cmm_echo" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(chatOnly.invocations).toBe(0);
    console.log("CHAT_ONLY_RESPONSES_REJECTION=PASS");
  });

  it("rejects tool_choice and parallel_tool_calls on CHAT_ONLY", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    for (const payload of [
      {
        model: "chatgpt/chat-only-model",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "auto",
      },
      {
        model: "chatgpt/chat-only-model",
        messages: [{ role: "user", content: "hi" }],
        parallel_tool_calls: false,
      },
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(BEARER),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe("unsupported_capability");
    }
    expect(chatOnly.invocations).toBe(0);
  });

  it("rejects tool-result continuation on CHAT_ONLY without fallback", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result", tool_call_id: "call-1" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(chatOnly.invocations).toBe(0);
    console.log("PROVIDER_INVOCATION_COUNT=0");
    console.log("CROSS_PROVIDER_FALLBACK=NONE");
  });

  it("allows CHAT_AND_TOOLS models to receive tools for the Qoder consumer", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: BEARER,
      qoderToken: QODER_BEARER,
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(QODER_BEARER),
      payload: {
        model: "claude/tools-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(capable.invocations).toBe(1);
  });

  it("CMMChat is still CHAT_ONLY even on a CHAT_AND_TOOLS model", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: BEARER,
      qoderToken: QODER_BEARER,
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(BEARER),
      payload: {
        model: "claude/tools-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(capable.invocations).toBe(0);
    console.log("CMMCHAT_TOOL_ESCALATION=NONE");
  });

  it("plain chat without tools still works on CHAT_ONLY", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(chatOnly.invocations).toBe(1);
    console.log("CHAT_ONLY_TOOL_ENFORCEMENT=PASS");
  });

  it("rejects assistant tool_calls history on chat completions", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "cmm_echo", arguments: "{}" },
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(chatOnly.invocations).toBe(0);
    console.log("CHAT_ONLY_ASSISTANT_TOOL_HISTORY_REJECTED=PASS");
  });

  it("rejects function_call history on responses", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(BEARER),
      payload: {
        model: "chatgpt/chat-only-model",
        input: [
          { role: "user", content: "hi" },
          { type: "function_call", call_id: "call-1", name: "cmm_echo", arguments: "{}" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(chatOnly.invocations).toBe(0);
  });
});
