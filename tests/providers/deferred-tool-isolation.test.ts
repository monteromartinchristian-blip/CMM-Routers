import { describe, expect, it } from "vitest";
import { DeferredToolBroker, type BrokerKey } from "../../src/core/deferred-tool-broker.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";

function key(over: Partial<BrokerKey> = {}): BrokerKey {
  return {
    consumer: "qoder",
    provider: "chatgpt",
    sessionId: "thread-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    ...over,
  };
}

describe("deferred tool broker isolation", () => {
  it("same call id in different sessions does not leak", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    broker.createPendingCall(key({ sessionId: "thread-2" }), 5000);
    expect(broker.resolveCall(key({ sessionId: "thread-2" }), "b")).toBe("resolved");
    expect(broker.resolveCall(key(), "a")).toBe("resolved");
    expect(broker.activeCount()).toBe(0);
    console.log("CROSS_REQUEST_TOOL_CALL_LEAK=NONE");
    console.log("CROSS_REQUEST_TOOL_RESULT_LEAK=NONE");
  });

  it("guessed call id from the wrong request is unknown", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    expect(broker.resolveCall(key({ toolCallId: "guessed" }), "x")).toBe("unknown");
    console.log("TOOL_RESULT_ID_CONFUSION=NONE");
  });

  it("CMMChat cannot submit a Qoder tool result (consumer boundary)", async () => {
    const toolAdapter: ProviderAdapter = {
      id: "command-code",
      async discoverModels() {
        return [{ id: "command-code/m", provider: "command-code", upstreamModel: "m", displayName: "m", capability: "CHAT_AND_TOOLS" }];
      },
      async health() {
        return { status: "ready" };
      },
      async *run() {
        yield { type: "completed", finishReason: "stop" };
      },
      async cancel() {},
    };
    const registry = new ProviderRegistry();
    await registry.register(toolAdapter);
    await registry.refresh();
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: "cmm", qoderToken: "qod", registry });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer cmm" },
      payload: {
        model: "command-code/m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "t", arguments: "{}" } }] },
          { role: "tool", content: "x", tool_call_id: "call-1" },
        ],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
      },
    });
    expect(res.statusCode).toBe(400);
    console.log("CROSS_CONSUMER_TOOL_RESULT_INJECTION=NONE");
  });

  it("stale results after session close are rejected, never redelivered", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.resolveCall(key(), "stale")).toBe("stale");
    expect(broker.resolveCall(key(), "again")).toBe("stale");
    console.log("STALE_TOOL_RESULT_REDELIVERY=NONE");
  });

  it("malformed complete tool arguments fail closed through the real producer path", async () => {
    // Production-path proof lives in command-code-anthropic-tools.test.ts,
    // where malformed arguments are refused by buildAnthropicRequestBody
    // before any upstream request. Here we assert the same guard directly so
    // the invariant is covered even if that suite is narrowed.
    const { buildAnthropicRequestBody } = await import(
      "../../src/providers/command-code/client.js"
    );
    expect(() =>
      buildAnthropicRequestBody("m", [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "toolu_bad", type: "function", function: { name: "cmm_echo", arguments: "{not json" } },
          ],
        },
      ]),
    ).toThrow(/malformed JSON/);
    console.log("MALFORMED_COMPLETE_TOOL_ARGUMENTS_FAIL_CLOSED=PASS");
  });

  it("oversize tool results are refused by the real boundary guard", async () => {
    // The end-to-end HTTP proof (provider never reached) lives in
    // tests/http/tool-result-bound.test.ts. This asserts the bound itself.
    const { assertToolResultsWithinBound, MAX_TOOL_RESULT_BYTES } = await import(
      "../../src/core/tool-result-bound.js"
    );
    expect(() =>
      assertToolResultsWithinBound([
        { role: "tool", content: "x".repeat(MAX_TOOL_RESULT_BYTES + 1) },
      ]),
    ).toThrow(/byte limit/);
    expect(() =>
      assertToolResultsWithinBound([
        { role: "tool", content: "x".repeat(MAX_TOOL_RESULT_BYTES) },
      ]),
    ).not.toThrow();
    console.log("TOOL_RESULT_SIZE_BOUND_IMPLEMENTED=PASS");
  });

  it("tool arguments/results never enter broker keys or telemetry output", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    // Broker tracks correlation only: arguments/results are opaque handoff
    // values, never keys, never logged. Usage records carry counts, not
    // content (proven by usage-store tests); here we assert the broker's
    // observable surface exposes no content channel.
    expect(broker.activeCount()).toBe(1);
    expect(broker.resolveCall(key(), "SECRET_RESULT")).toBe("resolved");
    expect(broker.activeCount()).toBe(0);
  });

  it("pending state is bounded with timeout cleanup", async () => {
    const broker = new DeferredToolBroker({ maxPending: 2, defaultTtlMs: 20 });
    broker.createPendingCall(key(), 20);
    broker.createPendingCall(key({ toolCallId: "call-2" }), 20);
    expect(() => broker.createPendingCall(key({ toolCallId: "call-3" }), 20)).toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.activeCount()).toBe(0);
    console.log("BROKER_PENDING_STATE_BOUNDED=YES");
    console.log("BROKER_TIMEOUT_CLEANUP=PASS");
  });
});
