import { describe, expect, it, vi, beforeEach } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  startup: vi.fn(),
  resolveSettings: vi.fn(),
}));

import { ClaudeAdapter, buildClaudeConversation } from "../../src/providers/claude/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function conversationRequest(): RouterRequest {
  return {
    requestId: "ctx-001",
    model: {
      id: "claude/sonnet",
      provider: "claude",
      upstreamModel: "sonnet",
      displayName: "Sonnet",
    },
    messages: [
      { role: "system", content: "SYSTEM_MARKER_123" },
      { role: "user", content: "USER_ONE_123" },
      { role: "assistant", content: "ASSISTANT_HISTORY_123" },
      { role: "user", content: "USER_TWO_123" },
    ],
    tools: [],
    stream: true,
  };
}

describe("Claude conversation preservation", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("builds system prompt plus ordered history frames", () => {
    const { systemPrompt, frames } = buildClaudeConversation(conversationRequest().messages);
    expect(systemPrompt).toContain("SYSTEM_MARKER_123");
    console.log("CLAUDE_SYSTEM_PRESERVED=YES");
    expect(frames.map((f) => f.text)).toEqual([
      "USER_ONE_123",
      "ASSISTANT_HISTORY_123",
      "USER_TWO_123",
    ]);
    expect(frames.map((f) => f.role)).toEqual(["user", "assistant", "user"]);
    console.log("CLAUDE_USER_HISTORY_PRESERVED=YES");
    console.log("CLAUDE_ASSISTANT_HISTORY_PRESERVED=YES");
    console.log("CLAUDE_MESSAGE_ORDER_PRESERVED=YES");
  });

  it("passes the actual constructed SDK input at runtime", async () => {
    queryMock.mockReturnValue({
      supportedModels: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: () => (async function* () {
        yield { type: "result", subtype: "success", usage: {} };
      })(),
    });
    const adapter = new ClaudeAdapter();
    for await (const _ of adapter.run(conversationRequest(), new AbortController().signal)) {
      // consume
    }
    const call = queryMock.mock.calls[0]?.[0] as
      | { prompt?: unknown; options?: Record<string, unknown> }
      | undefined;
    expect(call).toBeDefined();
    // System prompt travels via the dedicated SDK option.
    const systemPrompt = call?.options?.systemPrompt as
      | { type?: string; prompt?: string }
      | undefined;
    expect(systemPrompt?.prompt).toContain("SYSTEM_MARKER_123");
    // History travels as an async-iterable SDK user stream: drain it.
    const prompt = call?.prompt as AsyncIterable<{ message?: { role?: string; content?: unknown } }>;
    const streamed: Array<{ role?: string | undefined; content?: unknown }> = [];
    for await (const frame of prompt) {
      streamed.push({ role: frame.message?.role, content: frame.message?.content });
    }
    const texts = streamed.map((f) => String(f.content));
    expect(texts).toEqual(["USER_ONE_123", "ASSISTANT_HISTORY_123", "USER_TWO_123"]);
    expect(streamed.map((f) => f.role)).toEqual(["user", "assistant", "user"]);
  });
});
