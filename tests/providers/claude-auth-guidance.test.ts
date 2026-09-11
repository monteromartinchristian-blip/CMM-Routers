import { describe, expect, it, vi, beforeEach } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  startup: vi.fn().mockRejectedValue(new Error("not logged in, run login")),
  resolveSettings: vi.fn().mockResolvedValue({ effective: {}, provenance: {} }),
}));

import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function makeRequest(): RouterRequest {
  return {
    requestId: "guidance-001",
    model: {
      id: "claude/sonnet",
      provider: "claude",
      upstreamModel: "sonnet",
      displayName: "Sonnet",
    },
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
  };
}

describe("Claude auth guidance profile", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockReturnValue({
      supportedModels: vi.fn().mockRejectedValue(new Error("not logged in, run login")),
      interrupt: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: () => (async function* () {})(),
    });
  });

  it("targets the configured profile in auth guidance", async () => {
    const adapter = new ClaudeAdapter({ profileDir: "/custom/router/claude" });
    await expect(adapter.discoverModels()).rejects.toThrow(/\/custom\/router\/claude/);
    console.log("CLAUDE_AUTH_GUIDANCE_PROFILE=CONFIGURED");
  });

  it("falls back to the default profile when unconfigured", async () => {
    const adapter = new ClaudeAdapter();
    await expect(adapter.discoverModels()).rejects.toThrow(/SubscriptionRouter\/Claude/);
  });
});
