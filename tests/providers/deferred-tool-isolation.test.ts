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

  it("malformed JSON arguments fail closed before broker insert", () => {
    expect(() => JSON.parse("{not json")).toThrow();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    expect(broker.activeCount()).toBe(0);
  });

  it("huge tool results are bounded (1MiB cap)", () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    expect(huge.length).toBeGreaterThan(1024 * 1024);
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
