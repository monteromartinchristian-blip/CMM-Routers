import { describe, expect, it } from "vitest";
import {
  DeferredToolBroker,
  type BrokerKey,
} from "../../src/core/deferred-tool-broker.js";

function key(overrides: Partial<BrokerKey> = {}): BrokerKey {
  return {
    profile: "AGENT",
    provider: "chatgpt",
    sessionId: "thread-1",
    toolCallId: "call-1",
    ...overrides,
  };
}

describe("DeferredToolBroker profile binding", () => {
  it("keys pending calls by profile, so equal wire identity can coexist", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(key({ profile: "AGENT" }), 5000);
    broker.createPendingCall(
      key({ profile: "CHAT", sessionId: "thread-1", toolCallId: "call-1" }),
      5000,
    );
    expect(broker.activeCount()).toBe(2);
    expect(broker.resolveCall(key({ profile: "CHAT" }), "chat")).toBe("resolved");
    expect(broker.resolveCall(key({ profile: "AGENT" }), "agent")).toBe("resolved");
  });

  it("a CHAT continuation cannot claim an AGENT pending call", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(
      key({ profile: "AGENT", publicToolCallId: "public-agent" }),
      5000,
      undefined,
      { owner: "agent" },
    );
    const mismatched = broker.claimByPublicToolCallId("public-agent", "CHAT");
    expect(mismatched.outcome).toBe("unknown");
    // The rightful owner can still claim it: a mismatch does not consume state.
    const claimed = broker.claimByPublicToolCallId<{ owner: string }>(
      "public-agent",
      "AGENT",
    );
    expect(claimed.outcome).toBe("resolved");
    expect(claimed.context).toEqual({ owner: "agent" });
  });

  it("an AGENT continuation cannot claim a CHAT pending call", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(
      key({ profile: "CHAT", publicToolCallId: "public-chat" }),
      5000,
      undefined,
      { owner: "chat" },
    );
    expect(broker.claimByPublicToolCallId("public-chat", "AGENT").outcome).toBe("unknown");
    expect(broker.claimByPublicToolCallId("public-chat", "CHAT").outcome).toBe("resolved");
  });

  it("refuses a legacy consumer tag as a profile substitute", () => {
    const broker = new DeferredToolBroker();
    expect(() =>
      broker.createPendingCall(
        {
          consumer: "qoder",
          provider: "claude",
          sessionId: "session-1",
          toolCallId: "public-legacy",
          publicToolCallId: "public-legacy",
        } as unknown as BrokerKey,
        5000,
        undefined,
        { owner: "legacy" },
      ),
    ).toThrow(/requires a Router profile/);
  });

  it("rejects a key that names no profile", () => {
    const broker = new DeferredToolBroker();
    expect(() =>
      broker.createPendingCall({
        provider: "chatgpt",
        sessionId: "thread-1",
        toolCallId: "call-1",
      } as unknown as BrokerKey),
    ).toThrow(/requires a Router profile/);
  });

  it("scope cancellation remains provider/session based", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(key({ profile: "CHAT", toolCallId: "chat-1" }), 5000);
    broker.createPendingCall(key({ profile: "AGENT", toolCallId: "agent-1" }), 5000);
    broker.cancelScope({ provider: "chatgpt", sessionId: "thread-1" });
    expect(broker.activeCount()).toBe(0);
  });
});
