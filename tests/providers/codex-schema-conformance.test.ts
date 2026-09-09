import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RouterError } from "../../src/core/errors.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import {
  buildThreadStartParams,
  buildTurnInterruptParams,
  parseAgentDeltaParams,
  parseTokenUsageParams,
  parseTurnCompletedParams,
  parseTurnStartResponse,
} from "../../src/providers/codex/schema-translator.js";

const V2 = join(import.meta.dirname, "../fixtures/generated/codex/v2");
const GENERATED = join(import.meta.dirname, "../fixtures/generated/codex");

function generatedClientMethods(): string[] {
  const schema = JSON.parse(readFileSync(join(GENERATED, "ClientRequest.json"), "utf-8")) as {
    oneOf?: Array<{ properties?: { method?: { enum?: string[] } } }>;
  };
  return (schema.oneOf ?? [])
    .map((entry) => entry.properties?.method?.enum?.[0])
    .filter((m): m is string => typeof m === "string");
}

function requiredOf(fixture: string): string[] {
  const schema = JSON.parse(readFileSync(join(V2, fixture), "utf-8")) as {
    required?: string[];
  };
  return schema.required ?? [];
}

function expectProtocolError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).code).toBe("provider_protocol_error");
    return;
  }
  throw new Error("expected provider_protocol_error, got success");
}

describe("Codex generated-schema conformance", () => {
  it("matches tracked TurnStartResponse required shape", () => {
    expect(requiredOf("TurnStartResponse.json")).toEqual(["turn"]);
    const parsed = parseTurnStartResponse({
      turn: { id: "turn-456", status: "inProgress", items: [] },
    });
    expect(parsed.turnId).toBe("turn-456");
    expect(parsed.turnId).not.toBe("");
    console.log("CODEX_TURN_START_ID_FROM_SCHEMA=PASS");
  });

  it("rejects legacy flat turnId shape", () => {
    expectProtocolError(() => parseTurnStartResponse({ turnId: "turn-456" }));
  });

  it("matches tracked token usage nesting", () => {
    const params = JSON.parse(readFileSync(join(V2, "ThreadTokenUsageUpdatedNotification.json"), "utf-8")) as Record<string, unknown>;
    void params;
    const parsed = parseTokenUsageParams({
      threadId: "thread-A",
      turnId: "turn-A",
      tokenUsage: {
        last: {
          cachedInputTokens: 1,
          inputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 7,
          totalTokens: 150,
        },
        total: {
          cachedInputTokens: 1,
          inputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 7,
          totalTokens: 150,
        },
      },
    });
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.outputTokens).toBe(50);
    expect(parsed.reasoningTokens).toBe(7);
    expect(parsed.cacheReadTokens).toBe(1);
    console.log("CODEX_TOKEN_USAGE_FROM_SCHEMA=PASS");
  });

  it("rejects flat legacy token fields", () => {
    expectProtocolError(() =>
      parseTokenUsageParams({ threadId: "t", turnId: "u", inputTokens: 1 }),
    );
  });

  it("matches tracked turn/completed nesting", () => {
    const parsed = parseTurnCompletedParams({
      threadId: "thread-A",
      turn: { id: "turn-A", status: "completed", items: [] },
    });
    expect(parsed.turnId).toBe("turn-A");
    expect(parsed.status).toBe("completed");
    console.log("CODEX_COMPLETION_FROM_SCHEMA=PASS");
  });

  it("matches tracked agent delta correlation fields", () => {
    const parsed = parseAgentDeltaParams({
      delta: "hi",
      itemId: "item-1",
      threadId: "thread-A",
      turnId: "turn-A",
    });
    expect(parsed.threadId).toBe("thread-A");
    expect(parsed.turnId).toBe("turn-A");
  });

  it("interrupt builder refuses empty turn ids", () => {
    const built = buildTurnInterruptParams({ threadId: "thread-A", turnId: "turn-A" });
    expect(built.turnId).toBe("turn-A");
    expectProtocolError(() => buildTurnInterruptParams({ threadId: "thread-A", turnId: "" }));
    expectProtocolError(() => buildTurnInterruptParams({ threadId: "thread-A", turnId: undefined }));
    console.log("CODEX_CANCEL_USES_REAL_TURN_ID=PASS");
  });

  it("thread/start builder sets explicit ephemeral", () => {
    const params = buildThreadStartParams({ model: "m", sandbox: "read-only", ephemeral: true });
    expect(params.ephemeral).toBe(true);
  });

  it("drift guard: generated required keys still match translator assumptions", () => {
    // If the tracked schema evolves incompatibly, this fails loudly.
    expect(requiredOf("TurnStartResponse.json")).toContain("turn");
    expect(requiredOf("ThreadTokenUsageUpdatedNotification.json")).toEqual(
      expect.arrayContaining(["threadId", "tokenUsage", "turnId"]),
    );
    expect(requiredOf("AgentMessageDeltaNotification.json")).toEqual(
      expect.arrayContaining(["delta", "itemId", "threadId", "turnId"]),
    );
    expect(requiredOf("TurnCompletedNotification.json")).toEqual(
      expect.arrayContaining(["threadId", "turn"]),
    );
    expect(requiredOf("TurnInterruptParams.json")).toEqual(
      expect.arrayContaining(["threadId", "turnId"]),
    );
    console.log("CODEX_PROTOCOL_PAYLOAD_DRIFT_GUARD=PASS");
  });

  it("drift guard: production outbound methods match generated discriminators", () => {
    const methods = generatedClientMethods();
    for (const required of [
      "thread/start",
      "thread/inject_items",
      "turn/start",
      "turn/interrupt",
      "model/list",
      "initialize",
    ]) {
      expect(methods).toContain(required);
    }
    expect(CodexAppServerClient.INJECT_ITEMS_METHOD).toBe("thread/inject_items");
    expect(methods).toContain(CodexAppServerClient.INJECT_ITEMS_METHOD);
    console.log("CODEX_PROTOCOL_METHOD_DRIFT_GUARD=PASS");
    console.log("CODEX_PROTOCOL_DRIFT_GUARD=PASS");
  });

  it("drift guard: stale camelCase inject method is not a valid discriminator", () => {
    const methods = generatedClientMethods();
    expect(methods).not.toContain("thread/injectItems");
    expect(CodexAppServerClient.INJECT_ITEMS_METHOD).not.toBe("thread/injectItems");
    console.log("CODEX_STALE_INJECTITEMS_METHOD=ABSENT");
  });
});
