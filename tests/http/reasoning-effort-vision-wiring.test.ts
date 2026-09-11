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
import { buildCodexThreadSeeds, CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { buildClaudeConversation, toClaudeImageBlock, ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";
import { Duplex } from "node:stream";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const HTTP_URL = "https://example.invalid/cat.png";

class ScriptedProvider implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  lastRequest: RouterRequest | null = null;
  script: RouterEvent[] = [
    { type: "text_delta", text: "ok" },
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

  async *run(request: RouterRequest): AsyncIterable<RouterEvent> {
    this.lastRequest = request;
    for (const event of this.script) yield event;
  }

  async cancel(): Promise<void> {}
}

function auth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe("reasoning effort ingress — Chat Completions", () => {
  let registry: ProviderRegistry;
  let provider: ScriptedProvider;
  const bearerSecret = "test-secret-effort";

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new ScriptedProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  it("preserves reasoning_effort into RouterRequest", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "xhigh",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.lastRequest?.reasoningEffort).toBe("xhigh");
  });

  it("rejects an unknown reasoning_effort with 400 instead of coercing", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    for (const bad of ["minimal", "ultra", 3, ["high"]]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth(bearerSecret),
        payload: {
          model: "chatgpt/test-model",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: bad,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe("invalid_request");
    }
    expect(provider.lastRequest).toBeNull();
  });

  it("accepts multimodal text + image user content", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: DATA_URL } },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const message = provider.lastRequest?.messages[0];
    expect(message?.content).toBe("describe");
    expect(message?.images).toEqual([DATA_URL]);
  });
});

describe("reasoning effort ingress — Responses", () => {
  let registry: ProviderRegistry;
  let provider: ScriptedProvider;
  const bearerSecret = "test-secret-responses";

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new ScriptedProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  it("preserves the extended reasoning.effort enum", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        reasoning: { effort: "max" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.lastRequest?.reasoningEffort).toBe("max");
  });

  it("rejects an unknown reasoning.effort with 400", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        reasoning: { effort: "ultra" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request");
  });

  it("accepts input_image alongside input_text", async () => {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, registry });
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(bearerSecret),
      payload: {
        model: "chatgpt/test-model",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              { type: "input_image", image_url: HTTP_URL },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const message = provider.lastRequest?.messages[0];
    expect(message?.content).toBe("look");
    expect(message?.images).toEqual([HTTP_URL]);
  });
});

describe("Codex effort and image transport", () => {
  function codexMessages(content: string | null, images?: string[]) {
    return [
      { role: "user" as const, content: "first" },
      { role: "user" as const, content, ...(images ? { images } : {}) },
    ];
  }

  it("emits the image on the active turn input", () => {
    const seeds = buildCodexThreadSeeds(codexMessages("look", [DATA_URL]));
    expect(seeds.turnInput).toEqual([
      { type: "text", text: "look" },
      { type: "image", url: DATA_URL },
    ]);
  });

  it("places images from older turns into history items", () => {
    const seeds = buildCodexThreadSeeds([
      { role: "user", content: "old", images: [DATA_URL] },
      { role: "user", content: "new" },
    ]);
    const history = JSON.stringify(seeds.historyItems);
    expect(history).toContain(DATA_URL);
    expect(history).toContain("input_image");
    expect(seeds.turnInput).toEqual([{ type: "text", text: "new" }]);
  });

  it("leaves turn input unchanged for text-only requests", () => {
    const seeds = buildCodexThreadSeeds(codexMessages("only text"));
    expect(seeds.turnInput).toEqual([{ type: "text", text: "only text" }]);
  });
});

describe("Claude effort and image transport", () => {
  it("maps a data URL into a base64 image block", () => {
    expect(toClaudeImageBlock(DATA_URL)).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("maps a remote reference into a url image block", () => {
    expect(toClaudeImageBlock(HTTP_URL)).toEqual({
      type: "image",
      source: { type: "url", url: HTTP_URL },
    });
  });

  it("carries images on the owning user frame", () => {
    const conversation = buildClaudeConversation([
      { role: "user", content: "describe", images: [DATA_URL] },
    ]);
    expect(conversation.frames).toHaveLength(1);
    const frame = conversation.frames[0]!;
    expect(frame.text).toBe("describe");
    expect(frame.images).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  it("keeps a text-only frame free of an images member", () => {
    const conversation = buildClaudeConversation([{ role: "user", content: "plain" }]);
    expect(conversation.frames[0]).toEqual({ role: "user", text: "plain" });
  });
});

describe("Antigravity --effort wiring", () => {
  function adapter(): AntigravityAdapter {
    return new AntigravityAdapter();
  }

  it("appends --effort for an adjustable model", () => {
    const args = adapter().buildInferenceArgs("claude-sonnet-4-6", "prompt", "high");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("omits --effort when the caller specified none", () => {
    const args = adapter().buildInferenceArgs("claude-sonnet-4-6", "prompt");
    expect(args).not.toContain("--effort");
  });

  it("does not forward a level agy cannot accept", () => {
    const args = adapter().buildInferenceArgs("claude-sonnet-4-6", "prompt", "xhigh");
    expect(args).not.toContain("--effort");
  });

  it("adds no second effort control for a fixed-level Gemini slug", () => {
    const args = adapter().buildInferenceArgs("gemini-3.8-flash-low", "prompt");
    expect(args).not.toContain("--effort");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
  });
});

describe("Codex turn/start effort transport", () => {
  function codexHarness(): { adapter: CodexAdapter; seen: Array<{ method: string; params: Record<string, unknown> }> } {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    const duplex = new Duplex({
      read: () => {},
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        const msg = JSON.parse(chunk.toString()) as {
          method: string;
          params?: Record<string, unknown>;
          id?: unknown;
        };
        seen.push({ method: msg.method, params: msg.params ?? {} });
        if (msg.method === "initialize") {
          push({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "model/list") {
          push({
            jsonrpc: "2.0",
            id: msg.id,
            result: { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }] },
          });
        } else if (msg.method === "thread/start") {
          push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } });
        } else if (msg.method === "thread/inject_items") {
          push({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "turn/start") {
          push({
            jsonrpc: "2.0",
            id: msg.id,
            result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
          });
          queueMicrotask(() =>
            push({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
            }),
          );
        }
        callback();
      },
    });
    function push(message: object): void {
      duplex.push(`${JSON.stringify(message)}\n`);
    }
    const adapter = new CodexAdapter();
    (adapter as unknown as { client: unknown }).client = new CodexAppServerClient(duplex);
    return { adapter, seen };
  }

  function codexRequest(effort?: RouterRequest["reasoningEffort"]): RouterRequest {
    return {
      requestId: "effort-1",
      model: {
        id: "chatgpt/gpt-5",
        provider: "chatgpt",
        upstreamModel: "gpt-5",
        displayName: "GPT-5",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      stream: true,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    };
  }

  it("sends the selected effort on turn/start", async () => {
    const { adapter, seen } = codexHarness();
    for await (const _event of adapter.run(codexRequest("high"), new AbortController().signal)) {
      void _event;
    }
    const turnStart = seen.find((m) => m.method === "turn/start");
    expect(turnStart?.params.effort).toBe("high");
  });

  it("omits the effort field when no level was requested", async () => {
    const { adapter, seen } = codexHarness();
    for await (const _event of adapter.run(codexRequest(), new AbortController().signal)) {
      void _event;
    }
    const turnStart = seen.find((m) => m.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect("effort" in (turnStart?.params ?? {})).toBe(false);
  });
});

describe("Claude SDK effort transport", () => {
  function claudeHarness(): {
    adapter: ClaudeAdapter;
    captured: Array<Record<string, unknown>>;
  } {
    const captured: Array<Record<string, unknown>> = [];
    const queryFn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
      captured.push(args.options);
      return (async function* () {
        yield { type: "result", subtype: "success", stop_reason: "end_turn" };
      })();
    }) as never;
    return { adapter: new ClaudeAdapter({ queryFn }), captured };
  }

  function claudeRequest(effort?: RouterRequest["reasoningEffort"]): RouterRequest {
    return {
      requestId: "effort-claude",
      model: {
        id: "claude/sonnet",
        provider: "claude",
        upstreamModel: "sonnet",
        displayName: "Sonnet",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      stream: true,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    };
  }

  it("passes the selected effort through SDK options", async () => {
    const { adapter, captured } = claudeHarness();
    for await (const _event of adapter.run(claudeRequest("xhigh"), new AbortController().signal)) {
      void _event;
    }
    expect(captured[0]?.effort).toBe("xhigh");
  });

  it("leaves the SDK effort option absent when none was requested", async () => {
    const { adapter, captured } = claudeHarness();
    for await (const _event of adapter.run(claudeRequest(), new AbortController().signal)) {
      void _event;
    }
    expect("effort" in (captured[0] ?? {})).toBe(false);
  });
});
