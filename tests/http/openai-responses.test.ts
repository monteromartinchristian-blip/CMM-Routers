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
    { type: "usage", inputTokens: 4, outputTokens: 2 },
    { type: "completed", finishReason: "stop" },
  ];

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

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    for (const event of this.script) {
      yield event;
    }
  }

  async cancel() {}
}

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe("OpenAI Responses API", () => {
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

  it("rejects unauthenticated responses requests", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "chatgpt/test-model", input: "hi" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts string input and returns a response object", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", input: "hi" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("response");
    expect(body.model).toBe("chatgpt/test-model");
    expect(body.status).toBe("completed");
    expect(JSON.stringify(body.output)).toContain("Hello");
  });

  it("accepts message-style input", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        input: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().object).toBe("response");
  });

  it("rejects unknown model", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/nope", input: "hi" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
  });

  it("rejects missing input", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request");
  });

  it("streams Responses events ending with response.completed", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", input: "hi", stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const body = response.body;
    expect(body).toContain("response.created");
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("response.completed");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits function-call deltas for tool calls", async () => {
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
    // Tools require the Qoder consumer (capability policy).
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      qoderToken: qoderSecret,
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(qoderSecret),
      payload: {
        model: "chatgpt/test-model",
        input: "hi",
        tools: [
          {
            type: "function",
            name: "cmm_echo",
            description: "echo",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).toContain("cmm_echo");
  });

  it("maps provider errors without fallback", async () => {
    provider.script = [
      { type: "error", error: new RouterError("provider_timeout", "too slow") },
    ];
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authHeader(bearerSecret),
      payload: { model: "chatgpt/test-model", input: "hi" },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.type).toBe("provider_timeout");
  });
});
