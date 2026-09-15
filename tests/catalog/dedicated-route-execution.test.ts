import { describe, expect, it } from "vitest";
import {
  supportsExactResolvedRouteExecution,
} from "../../src/catalog/runtime-bridge.js";
import type { ProviderConnection } from "../../src/catalog/types.js";
import type { ProviderAdapter, RouterRequest } from "../../src/core/provider.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CavotiAdapter } from "../../src/providers/cavoti/adapter.js";

function requestFor(adapter: ProviderAdapter): RouterRequest {
  return {
    requestId: `exact-route-${adapter.id}`,
    model: {
      id: `${adapter.id}/route-model`,
      provider: adapter.id,
      upstreamModel: "route-model",
      displayName: "Route Model",
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    stream: false,
  };
}

function mismatchedConnection(): ProviderConnection {
  return {
    connectionId: "connection:mismatch",
    providerId: "openrouter",
    accountId: "account:mismatch",
    productId: "product:mismatch",
    connectionKind: "openai-chat-completions",
    status: "configured",
  };
}

function dedicatedAdapters(): ProviderAdapter[] {
  return [
    new CodexAdapter(),
    new ClaudeAdapter(),
    new AntigravityAdapter(),
    new CommandCodeAdapter(),
    new CavotiAdapter(),
  ];
}

describe("dedicated exact resolved-route execution", () => {
  it("declares the exact-route execution contract on every dedicated production adapter", () => {
    for (const adapter of dedicatedAdapters()) {
      expect(
        supportsExactResolvedRouteExecution(adapter),
        `${adapter.id} exact-route capability`,
      ).toBe(true);
    }
  });

  it("fails closed on a mismatched resolved provider before invoking the native runtime", async () => {
    for (const adapter of dedicatedAdapters()) {
      expect(supportsExactResolvedRouteExecution(adapter)).toBe(true);
      if (!supportsExactResolvedRouteExecution(adapter)) continue;

      const events = [];
      for await (const event of adapter.runWithResolvedExecution(
        requestFor(adapter),
        new AbortController().signal,
        mismatchedConnection(),
        "default",
        { value: `authorized:${adapter.id}` },
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        error: { code: "unknown_model" },
      });
    }
  });
});
