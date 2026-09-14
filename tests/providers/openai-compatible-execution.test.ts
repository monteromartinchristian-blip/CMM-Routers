import { describe, expect, it } from "vitest";
import {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleClient,
  type ProviderFetchFn,
  type ProviderHttpResponse,
} from "../../src/providers/openai-compatible/adapter.js";
import { defineProviderManifest, type ProviderManifest } from "../../src/providers/manifest.js";
import type { RouterEvent } from "../../src/core/events.js";
import { RouterError } from "../../src/core/errors.js";

const TEST_SECRET = "injected-test-secret";

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return defineProviderManifest({
    id: "deepseek",
    displayName: "DeepSeek API",
    billingClass: "payg",
    baseUrl: "https://api.deepseek.com/v1",
    auth: { scheme: "bearer", secretEnv: "DEEPSEEK_API_KEY" },
    discovery: { method: "GET", path: "/models" },
    apiStyles: ["openai-chat-completions"],
    toolCapability: "CHAT_AND_TOOLS",
    activation: { mode: "all", models: [] },
    ...overrides,
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function jsonSse(records: unknown[]): ReadableStream<Uint8Array> {
  return sseStream(
    records.map((record) => `data: ${JSON.stringify(record)}\n\n`).concat(["data: [DONE]\n\n"]),
  );
}

function recordingFetch(
  respond: (request: RecordedRequest) => ProviderHttpResponse,
): { fetchFn: ProviderFetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: ProviderFetchFn = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    requests.push(request);
    return respond(request);
  };
  return { fetchFn, requests };
}

function textResponse(status: number, text: string): ProviderHttpResponse {
  return { status, text: async () => text };
}

function runnable(adapter: OpenAiCompatibleAdapter, upstreamModel: string, extra: Record<string, unknown> = {}) {
  const request = {
    requestId: "wave-test-request",
    model: {
      id: `deepseek/${upstreamModel}`,
      provider: adapter.id,
      upstreamModel,
      displayName: upstreamModel,
      capability: "CHAT_AND_TOOLS",
    },
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: { name: "calculator", parameters: { type: "object" } },
      },
    ],
    stream: true,
    ...extra,
  };
  const controller = new AbortController();
  return { request: request as never, signal: controller.signal, controller };
}

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function errorOf(events: RouterEvent[]): RouterError | undefined {
  const last = events.find((event) => event.type === "error");
  return last && last.type === "error" ? (last.error as RouterError) : undefined;
}

describe("generic OpenAI-compatible execution path", () => {
  it("posts the exact model id to the manifest endpoint with bearer auth", async () => {
    const { fetchFn, requests } = recordingFetch(() =>
      textResponse(200, ""),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com/v1",
      secretEnv: "DEEPSEEK_API_KEY",
      secret: TEST_SECRET,
      providerLabel: "DeepSeek API",
      fetchFn,
    });
    const adapter = new OpenAiCompatibleAdapter({ manifest: manifest(), client });
    const { request, signal } = runnable(adapter, "deepseek-chat");

    await collect(adapter.run(request, signal));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.Authorization).toBe(`Bearer ${TEST_SECRET}`);
    expect(requests[0]!.body.model).toBe("deepseek-chat");
    expect(requests[0]!.body.stream).toBe(true);
  });

  it("streams text deltas and completes with the upstream finish reason", async () => {
    const { fetchFn } = recordingFetch(() => ({
      status: 200,
      text: async () => "",
      body: jsonSse([
        { choices: [{ delta: { role: "assistant", content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    }));
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat");

    const events = await collect(adapter.run(request, signal));

    expect(events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
    expect(errorOf(events)).toBeUndefined();
  });

  it("passes declared tool calls through and fails closed on an undeclared name", async () => {
    const toolChunk = (name: string, id = "call_1") => ({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, type: "function", function: { name, arguments: "{}" } },
            ],
          },
        },
      ],
    });
    const allowed = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn: recordingFetch(() => ({
          status: 200,
          text: async () => "",
          body: jsonSse([
            toolChunk("calculator"),
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]),
        })).fetchFn,
      }),
    });
    const allowedRun = runnable(allowed, "deepseek-chat");
    const events = await collect(allowed.run(allowedRun.request, allowedRun.signal));

    expect(events.filter((event) => event.type === "tool_call_delta")).toEqual([
      {
        type: "tool_call_delta",
        index: 0,
        id: "call_1",
        name: "calculator",
        argumentsDelta: "{}",
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: "tool_calls" });

    const denied = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn: recordingFetch(() => ({
          status: 200,
          text: async () => "",
          body: jsonSse([
            toolChunk("rm_rf_everything", "call_evil"),
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]),
        })).fetchFn,
      }),
    });
    const deniedRun = runnable(denied, "deepseek-chat");
    const deniedEvents = await collect(denied.run(deniedRun.request, deniedRun.signal));

    expect(deniedEvents.some((event) => event.type === "tool_call_delta")).toBe(false);
    expect(errorOf(deniedEvents)?.code).toBe("provider_protocol_error");
    expect(deniedEvents.some((event) => event.type === "completed")).toBe(false);
  });

  it("forwards the caller's tool policy and token bound unchanged", async () => {
    const { fetchFn, requests } = recordingFetch(() => ({
      status: 200,
      text: async () => "",
      body: jsonSse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    }));
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat", {
      maxOutputTokens: 321,
      toolChoice: { kind: "named", name: "calculator" },
      parallelToolCalls: false,
    });

    await collect(adapter.run(request, signal));

    expect(requests[0]!.body.max_tokens).toBe(321);
    expect(requests[0]!.body.tool_choice).toEqual({
      type: "function",
      function: { name: "calculator" },
    });
    expect(requests[0]!.body.parallel_tool_calls).toBe(false);
    expect(Array.isArray(requests[0]!.body.tools)).toBe(true);
  });

  it("reports provider usage numbers without deriving any of them", async () => {
    const { fetchFn } = recordingFetch(() => ({
      status: 200,
      text: async () => "",
      body: jsonSse([
        {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 2 },
            cost: 0.00042,
          },
        },
      ]),
    }));
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat");

    const events = await collect(adapter.run(request, signal));

    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      inputTokens: 11,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      costUsd: 0.00042,
    });
  });

  it("normalizes upstream status codes into router error categories", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "invalid api key", "provider_auth_required"],
      [402, "Insufficient balance", "provider_quota_exhausted"],
      [429, "rate limit exceeded", "provider_rate_limited"],
      [404, "model not found", "unknown_model"],
      [500, "internal", "provider_protocol_error"],
    ];
    for (const [status, body, code] of cases) {
      const adapter = new OpenAiCompatibleAdapter({
        manifest: manifest(),
        client: new OpenAiCompatibleClient({
          baseUrl: "https://api.deepseek.com/v1",
          secretEnv: "DEEPSEEK_API_KEY",
          secret: TEST_SECRET,
          providerLabel: "DeepSeek API",
          fetchFn: recordingFetch(() => textResponse(status, body)).fetchFn,
        }),
      });
      const { request, signal } = runnable(adapter, "deepseek-chat");

      const events = await collect(adapter.run(request, signal));

      expect(errorOf(events)?.code, `HTTP ${status}`).toBe(code);
      expect(events.some((event) => event.type === "completed")).toBe(false);
    }
  });

  it("fails closed without an upstream request when the model is not activated", async () => {
    const { fetchFn, requests } = recordingFetch(() => textResponse(200, ""));
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest({
        activation: { mode: "allowlist", models: ["deepseek-chat"] },
      }),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-reasoner");

    const events = await collect(adapter.run(request, signal));

    expect(requests).toHaveLength(0);
    expect(errorOf(events)?.code).toBe("unknown_model");
  });

  it("refuses a model id belonging to another provider", async () => {
    const { fetchFn, requests } = recordingFetch(() => textResponse(200, ""));
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat");
    (request as { model: { provider: string } }).model.provider = "openrouter";

    const events = await collect(adapter.run(request, signal));

    expect(requests).toHaveLength(0);
    expect(errorOf(events)?.code).toBe("unknown_model");
  });

  it("times out a stalled upstream with provider_timeout", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        timeoutMs: 20,
        fetchFn: () =>
          new Promise<ProviderHttpResponse>(() => {
            // Never settles: the client deadline must fire instead.
          }),
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat");

    const events = await collect(adapter.run(request, signal));

    expect(errorOf(events)?.code).toBe("provider_timeout");
  });

  it("stops silently when the caller aborts", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
        fetchFn: () => new Promise<ProviderHttpResponse>(() => undefined),
      }),
    });
    const { request, signal, controller } = runnable(adapter, "deepseek-chat");
    controller.abort();

    const events = await collect(adapter.run(request, signal));

    expect(events).toEqual([]);
  });

  it("is one adapter class for every manifest, with no provider-specific code path", () => {
    const deepseek = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "DeepSeek API",
      }),
    });
    const openrouter = new OpenAiCompatibleAdapter({
      manifest: manifest({
        id: "openrouter",
        displayName: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        auth: { scheme: "bearer", secretEnv: "OPENROUTER_API_KEY" },
      }),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://openrouter.ai/api/v1",
        secretEnv: "OPENROUTER_API_KEY",
        secret: TEST_SECRET,
        providerLabel: "OpenRouter",
      }),
    });

    expect(deepseek.constructor).toBe(openrouter.constructor);
    expect(deepseek.id).toBe("deepseek");
    expect(openrouter.id).toBe("openrouter");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(deepseek)).sort()).toEqual(
      Object.getOwnPropertyNames(Object.getPrototypeOf(openrouter)).sort(),
    );
  });

  it("refuses a manifest that does not declare the OpenAI chat-completions style", () => {
    expect(
      () =>
        new OpenAiCompatibleAdapter({
          manifest: manifest({ apiStyles: ["anthropic-messages"] }),
          client: new OpenAiCompatibleClient({
            baseUrl: "https://api.deepseek.com/v1",
            secretEnv: "DEEPSEEK_API_KEY",
            secret: TEST_SECRET,
            providerLabel: "DeepSeek API",
          }),
        }),
    ).toThrow(/openai-chat-completions/);
  });

  it("never exposes the credential value in an error message", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      manifest: manifest(),
      client: new OpenAiCompatibleClient({
        baseUrl: "https://api.deepseek.com/v1",
        secretEnv: "DEEPSEEK_API_KEY",
        providerLabel: "DeepSeek API",
        fetchFn: recordingFetch(() => textResponse(401, "unauthorized")).fetchFn,
      }),
    });
    const { request, signal } = runnable(adapter, "deepseek-chat");
    // No injected secret and no env var: the auth error must name the variable.
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    try {
      const events = await collect(adapter.run(request, signal));
      const error = errorOf(events);
      expect(error?.code).toBe("provider_auth_required");
      expect(error?.message).toContain("DEEPSEEK_API_KEY");
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET);
    } finally {
      if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
