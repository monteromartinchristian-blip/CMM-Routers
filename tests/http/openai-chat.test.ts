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
import { RouterError } from "../../src/core/errors.js";

class ScriptedProvider implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  script: RouterEvent[] = [
    { type: "text_delta", text: "Hello" },
    { type: "usage", inputTokens: 3, outputTokens: 1 },
    { type: "completed", finishReason: "stop" },
  ];
  lastRequest: RouterRequest | null = null;
  cancelled: string[] = [];

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/test-model",
        provider: "chatgpt",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.lastRequest = request;
    for (const event of this.script) {
      yield event;
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe("OpenAI Chat Completions", () => {
  let registry: ProviderRegistry;
  let provider: ScriptedProvider;
  const bearerSecret = "test-secret-123";
  const qoderSecret = "qoder-secret-456";

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new ScriptedProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  it("rejects unauthenticated chat requests", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "chatgpt/test-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects unknown provider", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "nope/model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_provider");
  });

  it("rejects unknown model", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/nope", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
  });

  it("rejects missing messages", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request");
  });

  it("returns non-streaming OpenAI-compatible completion", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("chatgpt/test-model");
    expect(body.choices[0].message).toMatchObject({ role: "assistant", content: "Hello" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it("streams SSE chunks ending with [DONE]", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(body).toContain("Hello");
  });

  it("maps provider tool calls to OpenAI tool_calls shape", async () => {
    provider.script = [
      {
        type: "tool_call_delta",
        index: 0,
        id: "call-1",
        name: "cmm_echo",
        argumentsDelta: '{"text":"x"}',
      },
      { type: "completed", finishReason: "tool_calls" },
    ];
    // Tools require the Qoder consumer (capability policy); plain chat does not.
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      qoderToken: qoderSecret,
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(qoderSecret),
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "cmm_echo",
              description: "echo",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: "call-1",
      type: "function",
      function: { name: "cmm_echo" },
    });
  });

  it("maps provider errors without fallback", async () => {
    provider.script = [
      { type: "error", error: new RouterError("provider_rate_limited", "slow down") },
    ];
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.type).toBe("provider_rate_limited");
  });

  it("resolves the exact requested model, never a substitute", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(provider.lastRequest?.model.id).toBe("chatgpt/test-model");
    expect(provider.lastRequest?.model.upstreamModel).toBe("test-model");
  });

  it("forwards tools and generation controls", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      qoderToken: qoderSecret,
      registry,
    });
    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(qoderSecret),
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 7,
        tools: [
          {
            type: "function",
            function: {
              name: "cmm_echo",
              description: "echo",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
      },
    });
    expect(provider.lastRequest?.maxOutputTokens).toBe(7);
    expect(provider.lastRequest?.tools.length).toBe(1);
  });

  it("concurrent requests stay isolated", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const payload = {
      model: "chatgpt/test-model",
      messages: [{ role: "user", content: "hi" }],
    };
    const [a, b] = await Promise.all([
      server.inject({ method: "POST", url: "/v1/chat/completions", headers: authHeader(bearerSecret), payload }),
      server.inject({ method: "POST", url: "/v1/chat/completions", headers: authHeader(bearerSecret), payload }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().choices[0].message.content).toBe("Hello");
    expect(b.json().choices[0].message.content).toBe("Hello");
  });

  it("never leaks secrets in responses", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(JSON.stringify(response.json())).not.toContain(bearerSecret);
  });
});
