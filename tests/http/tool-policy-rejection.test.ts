import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { codexUnsupportedToolPolicy } from "../../src/http/openai-chat.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

class ChatGptDouble implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  seen: RouterRequest[] = [];

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
    this.seen.push(request);
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel() {}
}

describe("Codex tool-policy constraints are never silently dropped", () => {
  let registry: ProviderRegistry;
  let provider: ChatGptDouble;
  const bearerSecret = "s";
  const qoderSecret = "q";

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new ChatGptDouble();
    await registry.register(provider);
    await registry.refresh();
  });

  function server() {
    return buildServer({ host: "127.0.0.1", port: 0, bearerSecret, qoderToken: qoderSecret, registry });
  }

  it("rejects forced tool_choice consistently on chat and responses", async () => {
    const chat = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "required",
      },
    });
    expect(chat.statusCode).toBe(400);
    expect(JSON.parse(chat.body).error.type).toBe("unsupported_capability");

    const responses = await server().inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload: { model: "chatgpt/test-model", input: "hi", tool_choice: "required" },
    });
    expect(responses.statusCode).toBe(400);
    expect(JSON.parse(responses.body).error.type).toBe("unsupported_capability");
    expect(provider.seen.length).toBe(0);
    console.log("SILENT_TOOL_CHOICE_DROP=NONE");
  });

  it("rejects parallel_tool_calls=false on chat and responses", async () => {
    const chat = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload: {
        model: "chatgpt/test-model",
        messages: [{ role: "user", content: "hi" }],
        parallel_tool_calls: false,
      },
    });
    expect(chat.statusCode).toBe(400);

    const responses = await server().inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload: { model: "chatgpt/test-model", input: "hi", parallel_tool_calls: false },
    });
    expect(responses.statusCode).toBe(400);
    console.log("SILENT_PARALLEL_TOOL_POLICY_DROP=NONE");
  });

  it("does not constrain non-Codex providers", () => {
    // The shared policy consumes the API-independent NORMALIZED form.
    expect(codexUnsupportedToolPolicy("command-code", { kind: "required" }, false)).toBeNull();
    expect(codexUnsupportedToolPolicy("chatgpt", { kind: "auto" }, true)).toBeNull();
    expect(codexUnsupportedToolPolicy("chatgpt", { kind: "required" }, undefined)).not.toBeNull();
    // No proven provider-side parallel control for claude/google: absence is
    // accepted, ANY explicit boolean is refused.
    expect(codexUnsupportedToolPolicy("claude", { kind: "auto" }, undefined)).toBeNull();
    expect(codexUnsupportedToolPolicy("claude", undefined, false)?.code).toBe(
      "unsupported_capability",
    );
    expect(codexUnsupportedToolPolicy("claude", undefined, true)?.code).toBe(
      "unsupported_capability",
    );
    expect(codexUnsupportedToolPolicy("google", { kind: "named", name: "t" }, undefined)?.code).toBe(
      "unsupported_capability",
    );
    expect(codexUnsupportedToolPolicy("google", undefined, false)?.code).toBe(
      "unsupported_capability",
    );
    expect(codexUnsupportedToolPolicy("google", undefined, undefined)).toBeNull();
  });
});
