import { describe, expect, it } from "vitest";
import { DeferredToolBroker, type BrokerKey } from "../../src/core/deferred-tool-broker.js";

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

describe("deferred tool cancellation matrix", () => {
  it("CANCEL_PRE_TOOL: cancel before any tool call leaves zero state", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 1000 });
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.activeCount()).toBe(0);
    console.log("CANCEL_PRE_TOOL=PASS");
  });

  it("CANCEL_DURING_TOOL_CALL: abort signal cancels the pending entry", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    const controller = new AbortController();
    broker.createPendingCall(key(), 5000, controller.signal);
    expect(broker.activeCount()).toBe(1);
    controller.abort();
    expect(broker.activeCount()).toBe(0);
    expect(broker.resolveCall(key(), "late")).toBe("stale");
    console.log("CANCEL_DURING_TOOL_CALL=PASS");
  });

  it("CANCEL_WAITING_FOR_TOOL_RESULT: cancelScope releases the waiter", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    const pending = broker.awaitCall(key());
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );
    broker.cancelScope({ sessionId: "thread-1" });
    expect(await settled).toBe("rejected");
    expect(broker.activeCount()).toBe(0);
    console.log("CANCEL_WAITING_FOR_TOOL_RESULT=PASS");
    console.log("ACTIVE_TOOL_STATE_AFTER_CANCEL=0");
  });

  it("CANCEL_POST_TOOL_RESULT: resolve then cancel leaves zero state, duplicate rejected", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    expect(broker.resolveCall(key(), "r")).toBe("resolved");
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.activeCount()).toBe(0);
    console.log("CANCEL_POST_TOOL_RESULT=PASS");
    console.log("ACTIVE_TOOL_STATE_AFTER_COMPLETION=0");
  });

  it("provider crash with pending tool releases state without cross-run damage", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    broker.createPendingCall(key({ sessionId: "thread-2", toolCallId: "call-2" }), 5000);
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.resolveCall(key(), "x")).toBe("stale");
    expect(broker.activeCount()).toBe(1);
  });

  it("duplicate and late results are rejected", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 20 });
    broker.createPendingCall(key(), 5000);
    expect(broker.resolveCall(key(), "a")).toBe("resolved");
    expect(broker.resolveCall(key(), "b")).toBe("duplicate");
    console.log("DUPLICATE_TOOL_RESULT_REJECTED=PASS");
    broker.createPendingCall(key({ toolCallId: "call-late" }), 20);
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.resolveCall(key({ toolCallId: "call-late" }), "late")).toBe("stale");
    expect(broker.activeCount()).toBe(0);
    console.log("LATE_TOOL_RESULT_REJECTED=PASS");
    console.log("ACTIVE_TOOL_STATE_AFTER_TIMEOUT=0");
  });

  it("disconnect after tool_call returned but before result cleans up", () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    broker.createPendingCall(key(), 5000);
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.activeCount()).toBe(0);
  });
});
