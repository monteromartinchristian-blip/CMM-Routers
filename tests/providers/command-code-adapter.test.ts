import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import { RouterError } from "../../src/core/errors.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function validAck(dir: string): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    }),
  );
  return path;
}

function makeRequest(upstreamModel = "goat-model-a"): RouterRequest {
  return {
    requestId: "cc-test-001",
    model: {
      id: `command-code/${upstreamModel}`,
      provider: "command-code",
      upstreamModel,
      displayName: upstreamModel,
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

type FakeResponse = { status: number; body: string };

function fakeFetch(responses: Record<string, FakeResponse>, seen: { url: string; init: { headers: Record<string, string>; body?: string | undefined } }[]) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string | undefined; signal?: AbortSignal | undefined }) => {
    seen.push({ url, init: { headers: init.headers, body: init.body } });
    const key = `${init.method} ${url}`;
    const match = responses[key] ?? responses[url] ?? { status: 404, body: "not found" };
    return { status: match.status, text: async () => match.body };
  };
}

describe("Command Code adapter", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-"));
    ackPath = validAck(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("has id command-code", () => {
    const adapter = new CommandCodeAdapter({ ackPath, client: new CommandCodeClient({ secret: "s" }) });
    expect(adapter.id).toBe("command-code");
  });

  it("discovers models with command-code/* namespace", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const client = new CommandCodeClient({
      secret: "test-secret",
      fetchFn: fakeFetch(
        {
          "GET https://api.commandcode.ai/provider/v1/models": {
            status: 200,
            body: JSON.stringify({ data: [{ id: "goat-model-a" }, { id: "goat-model-b" }] }),
          },
        },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const models = await adapter.discoverModels();
    expect(models.map((m) => m.id)).toEqual(["command-code/goat-model-a", "command-code/goat-model-b"]);
    // "goat-model-*" is not a Claude/Anthropic family id → OpenAI wire, which
    // carries the structured tool round-trip → CHAT_AND_TOOLS.
    expect(models[0]!.capability).toBe("CHAT_AND_TOOLS");
    expect(seen[0]!.init.headers.Authorization).toBe("Bearer test-secret");
  });

  it("documents the global-catalog limitation: bare entries carry no entitlement", async () => {
    const { readGoatEntitlement } = await import(
      "../../src/providers/command-code/client.js"
    );
    // Observed live shape: bare catalog entries, no entitlement fields.
    expect(readGoatEntitlement({ id: "claude-haiku-4-5-20251001" })).toBeNull();
    expect(readGoatEntitlement({ id: "deepseek/deepseek-v4-flash" })).toBeNull();
    // Authoritative metadata, when present, decides inclusion.
    expect(readGoatEntitlement({ id: "m", goat_included: true })).toBe(true);
    expect(readGoatEntitlement({ id: "m", included_plans: ["GOAT"] })).toBe(true);
    expect(readGoatEntitlement({ id: "m", included_plans: ["Pro"] })).toBe(false);
    expect(readGoatEntitlement({ id: "m", requires_extra_credits: true })).toBe(false);
  });

  it("maps MODEL_NOT_IN_PLAN to provider_quota_exhausted without retry or spend", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/messages": {
            status: 403,
            body: 'MODEL_NOT_IN_PLAN: Claude Haiku 4.5 available in Pro and above plans or extra on demand usage',
          },
        },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest("claude-haiku-4-5-20251001"), new AbortController().signal)) {
      events.push(event);
    }
    // Exactly one request: no endpoint retry, no model fallback, no spend.
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe("https://api.commandcode.ai/provider/v1/messages");
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_quota_exhausted");
    expect(events.filter((e) => (e as { type: string }).type === "text_delta")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("chat/completions");
  });

  it("exposes only metadata-proven GOAT models via goatUsableModels", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "GET https://api.commandcode.ai/provider/v1/models": {
            status: 200,
            body: JSON.stringify({
              data: [
                { id: "deepseek/deepseek-v4-flash", included_plans: ["GOAT"] },
                { id: "claude-haiku-4-5", included_plans: ["Pro"] },
                { id: "mystery-model" },
              ],
            }),
          },
        },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const models = await adapter.discoverModels();
    // KNOWN_EXCLUDED (claude-haiku-4-5, Pro-only) is hidden at discovery.
    expect(models.map((m) => m.upstreamModel).sort()).toEqual([
      "deepseek/deepseek-v4-flash",
      "mystery-model",
    ]);
    const usable = adapter.goatUsableModels(models);
    expect(usable.map((m) => m.upstreamModel)).toEqual(["deepseek/deepseek-v4-flash"]);
  });

  it("keeps unknown-entitlement catalog visible without assuming inclusion", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "GET https://api.commandcode.ai/provider/v1/models": {
            status: 200,
            body: JSON.stringify({
              data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "claude-haiku-4-5-20251001" }],
            }),
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const models = await adapter.discoverModels();
    // Both remain dynamically discoverable: no static plan assumption.
    expect(models.length).toBe(2);
    for (const model of models) {
      expect(adapter.entitlementOf(model)).toBe("UNKNOWN");
      expect(
        (model as unknown as Record<string, unknown>).goatIncluded,
      ).not.toBe(true);
    }
    // Production usability guard: a bare catalog must not disable the provider.
    expect(models.length).toBeGreaterThan(0);
  });

  it("filters explicit exclusion metadata but keeps unknown entries", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "GET https://api.commandcode.ai/provider/v1/models": {
            status: 200,
            body: JSON.stringify({
              data: [
                { id: "deepseek/deepseek-v4-flash", included_plans: ["GOAT"] },
                { id: "claude-haiku-4-5", included_plans: ["Pro"] },
                { id: "mystery-model" },
              ],
            }),
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const models = await adapter.discoverModels();
    // KNOWN_EXCLUDED is hidden from discovery; UNKNOWN stays visible.
    expect(models.map((m) => m.upstreamModel).sort()).toEqual([
      "deepseek/deepseek-v4-flash",
      "mystery-model",
    ]);
    expect(adapter.entitlementOf(models[0]!)).toBe("KNOWN_INCLUDED");
    expect(adapter.entitlementOf(models[1]!)).toBe("UNKNOWN");
  });

  it("classifies wires without a static model catalog", async () => {
    const { classifyCommandCodeWire } = await import(
      "../../src/providers/command-code/client.js"
    );
    expect(classifyCommandCodeWire("claude-sonnet-5").wire).toBe("anthropic-messages");
    expect(classifyCommandCodeWire("anthropic-claude-x").wire).toBe("anthropic-messages");
    expect(classifyCommandCodeWire("gpt-5-mini").wire).toBe("openai-chat-completions");
    expect(classifyCommandCodeWire("deepseek-v4").wire).toBe("openai-chat-completions");
    expect(classifyCommandCodeWire("kimi-k2").wire).toBe("openai-chat-completions");
    // Explicit wire metadata wins over the family rule.
    expect(
      classifyCommandCodeWire("mystery-model", { api: "anthropic-messages" }).wire,
    ).toBe("anthropic-messages");
    expect(
      classifyCommandCodeWire("claude-sonnet-5", { api: "openai" }).wire,
    ).toBe("openai-chat-completions");
  });

  it("routes Claude models to POST /provider/v1/messages only", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const anthropicStream = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      "",
      'data: {"type":"content_block_delta","delta":{"text_delta":"hi"}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        { "POST https://api.commandcode.ai/provider/v1/messages": { status: 200, body: anthropicStream } },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: { type: string }[] = [];
    for await (const event of adapter.run(makeRequest("claude-sonnet-5"), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe("https://api.commandcode.ai/provider/v1/messages");
    const body = JSON.parse(seen[0]!.init.body!);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.stream).toBe(true);
    expect(typeof body.max_tokens).toBe("number");
    expect(body).not.toHaveProperty("stream_options");
    expect(body).not.toHaveProperty("tools");
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage", "completed"]);
  });

  it("routes GPT models to POST /provider/v1/chat/completions only", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "",
    ].join("\n\n");
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        { "POST https://api.commandcode.ai/provider/v1/chat/completions": { status: 200, body: sse } },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: { type: string }[] = [];
    for await (const event of adapter.run(makeRequest("gpt-5-mini"), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect(events.map((e) => e.type)).toContain("completed");
  });

  it("unknown model still fails closed with no fallback request", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 404,
            body: "unknown model",
          },
        },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest("gpt-nope-1"), new AbortController().signal)) {
      events.push(event);
    }
    // Exactly one request: deterministic routing forbids endpoint retry.
    expect(seen.length).toBe(1);
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("unknown_model");
  });

  it("maps wrong-wire rejection to provider_protocol_error", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/messages": {
            status: 400,
            body: '{"error":"unsupported_model for this endpoint"}',
          },
        },
        [],
      ),
    });
    // Force the Anthropic wire via model metadata to hit /messages.
    const AnthropicModelClient = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/messages": {
            status: 400,
            body: '{"error":"unsupported_model for this endpoint"}',
          },
        },
        [],
      ),
    });
    void client;
    const adapter = new CommandCodeAdapter({ ackPath, client: AnthropicModelClient });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest("claude-sonnet-5"), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_protocol_error");
  });

  it("parses Anthropic streams: partial chunks, usage, terminal completion", async () => {
    const { parseAnthropicStreamEvents } = await import(
      "../../src/providers/command-code/client.js"
    );
    const body = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":8}}}',
      "",
      'data: {"type":"content_block_delta","delta":{"text_delta":"hel"}}',
      "",
      'data: {"type":"content_block_delta","delta":{"text_delta":"lo"}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const state = parseAnthropicStreamEvents(body);
    expect(state.textDeltas.join("")).toBe("hello");
    expect(state.inputTokens).toBe(8);
    expect(state.outputTokens).toBe(2);
    expect(state.completed).toBe(true);
  });

  it("rejects malformed Anthropic events and surfaces upstream errors", async () => {
    const { parseAnthropicStreamEvents } = await import(
      "../../src/providers/command-code/client.js"
    );
    expect(() => parseAnthropicStreamEvents("data: {not json}\n\n")).toThrow(RouterError);
    const errState = parseAnthropicStreamEvents(
      'data: {"type":"error","error":{"message":"overloaded"}}\n\n',
    );
    expect(errState.error).toContain("overloaded");
    // No message_stop → no synthetic completion.
    const incomplete = parseAnthropicStreamEvents(
      'data: {"type":"content_block_delta","delta":{"text_delta":"x"}}\n\n',
    );
    expect(incomplete.completed).toBe(false);
  });

  it("builds Anthropic requests without OpenAI-only fields", async () => {
    const { buildAnthropicRequestBody } = await import(
      "../../src/providers/command-code/client.js"
    );
    const body = buildAnthropicRequestBody(
      "claude-sonnet-5",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      5000,
    );
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stream_options");
    expect((body.messages as unknown[]).length).toBe(2);
  });

  it("never logs the auth header value", async () => {
    const { buildAuthHeaders, safeLogContext } = await import(
      "../../src/providers/command-code/client.js"
    );
    const headers = buildAuthHeaders("super-secret-value");
    const logged = JSON.stringify(safeLogContext("GET", "/models", headers));
    expect(logged).not.toContain("super-secret-value");
    expect(logged).toContain("[REDACTED]");
  });

  it("is disabled when the spending acknowledgement is absent", async () => {
    const client = new CommandCodeClient({ secret: "s" });
    const adapter = new CommandCodeAdapter({ ackPath: join(dir, "missing.json"), client });
    await expect(adapter.discoverModels()).rejects.toThrow(RouterError);
    const health = await adapter.health();
    expect(health.status).toBe("auth_required");
  });

  it("is disabled when the secret is missing", async () => {
    const original = process.env.COMMAND_CODE_SECRET;
    delete process.env.COMMAND_CODE_SECRET;
    try {
      const client = new CommandCodeClient({});
      const adapter = new CommandCodeAdapter({ ackPath, client });
      await expect(adapter.discoverModels()).rejects.toMatchObject({
        code: "provider_auth_required",
      });
    } finally {
      if (original !== undefined) process.env.COMMAND_CODE_SECRET = original;
    }
  });

  it("pins the exact selected model in the chat request", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "",
    ].join("\n\n");
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        { "POST https://api.commandcode.ai/provider/v1/chat/completions": { status: 200, body: sse } },
        seen,
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: { type: string }[] = [];
    for await (const event of adapter.run(makeRequest("goat-model-a"), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    const body = JSON.parse(seen[0]!.init.body!);
    expect(body.model).toBe("goat-model-a");
    expect(events.map((e) => e.type)).toContain("completed");
  });

  it("streams text deltas, tool calls, usage, and completion", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"cmm_echo","arguments":"{\\"text\\":\\"x\\"}"}}]}}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
      "",
    ].join("\n\n");
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        { "POST https://api.commandcode.ai/provider/v1/chat/completions": { status: 200, body: sse } },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: { type: string }[] = [];
    // The returned tool call must be declared by the request: an undeclared
    // provider tool request now fails closed at the adapter boundary.
    const declared = makeRequest();
    declared.tools = [CMM_ECHO_TOOL];
    declared.model.capability = "CHAT_AND_TOOLS";
    for await (const event of adapter.run(declared, new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_call_delta",
      "usage",
      "completed",
    ]);
  });

  it("maps 401 to provider_auth_required", async () => {
    const client = new CommandCodeClient({
      secret: "bad",
      fetchFn: fakeFetch(
        {
          "GET https://api.commandcode.ai/provider/v1/models": { status: 401, body: "invalid secret" },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    await expect(adapter.discoverModels()).rejects.toMatchObject({
      code: "provider_auth_required",
    });
  });

  it("maps 429 to provider_rate_limited", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 429,
            body: "rate limit exceeded",
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_rate_limited");
  });

  it("maps insufficient credits to provider_quota_exhausted", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 402,
            body: "insufficient credits",
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_quota_exhausted");
  });

  it("maps malformed SSE to provider_protocol_error", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 200,
            body: "data: {not json}\n\n",
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_protocol_error");
  });

  it("maps unknown model to unknown_model without fallback", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 404,
            body: "unknown model",
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest("no-such-model"), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("unknown_model");
    expect(events.filter((e) => (e as { type: string }).type === "text_delta")).toEqual([]);
  });

  it("supports cancellation and cleans up active requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: (async (_url: string, _init: { signal?: AbortSignal }) => {
        await gate;
        return { status: 200, text: async () => "" };
      }) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const request = makeRequest();
    const runPromise = (async () => {
      const events: unknown[] = [];
      for await (const event of adapter.run(request, new AbortController().signal)) {
        events.push(event);
      }
      return events;
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.cancel(request.requestId);
    release();
    await runPromise;
    expect(
      (adapter as unknown as { pending: Map<string, unknown> }).pending.has(request.requestId),
    ).toBe(false);
  });

  it("forbids spending paths like /extra", async () => {
    const { assertNoSpendPath } = await import("../../src/providers/command-code/spend-guard.js");
    expect(() => assertNoSpendPath("/extra")).toThrow(RouterError);
    expect(() => assertNoSpendPath("https://api.commandcode.ai/provider/v1/extra")).toThrow(
      RouterError,
    );
  });

  it("never switches to another provider on failure", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      fetchFn: fakeFetch(
        {
          "POST https://api.commandcode.ai/provider/v1/chat/completions": {
            status: 500,
            body: "internal error",
          },
        },
        [],
      ),
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    expect(adapter.id).toBe("command-code");
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError; type: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(JSON.stringify(events)).not.toContain("chatgpt/");
    expect(JSON.stringify(events)).not.toContain("claude/");
    expect(JSON.stringify(events)).not.toContain("google/");
  });
});
