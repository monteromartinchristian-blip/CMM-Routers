import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import { RouterError } from "../../src/core/errors.js";

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
    expect(models[0]!.capability).toBe("CHAT_ONLY");
    expect(seen[0]!.init.headers.Authorization).toBe("Bearer test-secret");
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
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"cmm_echo","arguments":"{\\"text\\":\\"x\\"}"}}]}}]}',
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
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
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
