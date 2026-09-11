import { describe, expect, it } from "vitest";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";

const KEY = {
  consumer: "qoder" as const,
  provider: "chatgpt" as const,
  sessionId: "thread-1",
  turnId: "turn-1",
  toolCallId: "call-1",
};

describe("DeferredToolBroker", () => {
  it("resolves a pending call exactly once and rejects duplicates", () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    expect(broker.resolveCall(KEY, "result-1")).toBe("resolved");
    expect(broker.resolveCall(KEY, "result-2")).toBe("duplicate");
    expect(broker.activeCount()).toBe(0);
  });

  it("rejects late results after TTL expiry", async () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 10 });
    broker.createPendingCall(KEY, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(broker.resolveCall(KEY, "late")).toBe("stale");
    expect(broker.activeCount()).toBe(0);
  });

  it("refuses new entries when bounded, never evicts live ones", () => {
    const broker = new DeferredToolBroker({ maxPending: 1, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    expect(() =>
      broker.createPendingCall({ ...KEY, toolCallId: "call-2" }, 1000),
    ).toThrow(/bounded/);
    expect(broker.activeCount()).toBe(1);
  });

  it("cancelScope releases only the matching scope", () => {
    const broker = new DeferredToolBroker({ maxPending: 4, defaultTtlMs: 1000 });
    broker.createPendingCall(KEY, 1000);
    broker.createPendingCall({ ...KEY, sessionId: "thread-2", toolCallId: "call-2" }, 1000);
    broker.cancelScope({ sessionId: "thread-1" });
    expect(broker.resolveCall(KEY, "x")).toBe("stale");
    expect(broker.activeCount()).toBe(1);
  });
});
