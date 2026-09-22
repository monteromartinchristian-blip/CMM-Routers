import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeferredToolBroker,
  createPublicToolCallId,
  type BrokerKey,
  type PendingToolContext,
} from "../../src/core/deferred-tool-broker.js";

const REPO = join(import.meta.dirname, "../..");

/**
 * Phase 3 — broker client-neutrality.
 *
 * The deferred tool broker is shared correlation infrastructure. It must carry
 * no client identity: the authorization subject lives at the HTTP boundary
 * (authenticated profile) and the execution owner is the client/harness, which
 * the broker never needs to name. Correlation, cancellation, bounds and
 * isolation must be unchanged by that neutrality.
 *
 * The key objects below are deliberately built WITHOUT any client identity
 * field. Before neutralization the broker refused such an entry at runtime.
 */

function neutralKey(overrides: Partial<BrokerKey> = {}): BrokerKey {
  return {
    provider: "claude",
    sessionId: "session-1",
    toolCallId: "public-1",
    publicToolCallId: "public-1",
    ...overrides,
  } as BrokerKey;
}

/** A key built the way a pre-neutralization caller did, for compatibility checks. */
function legacyShapedKey(): BrokerKey {
  return {
    provider: "claude",
    sessionId: "session-legacy",
    toolCallId: "public-legacy",
    publicToolCallId: "public-legacy",
    consumer: "qoder",
  } as unknown as BrokerKey;
}

describe("deferred tool broker is client-neutral", () => {
  it("BROKER_CLIENT_NEUTRAL: accepts and resolves an entry that names no client", () => {
    const broker = new DeferredToolBroker();
    const key = neutralKey();

    broker.createPendingCall(key, 5_000, undefined, { provider: "claude" } satisfies PendingToolContext);
    expect(broker.activeCount()).toBe(1);

    const claimed = broker.claimByPublicToolCallId<PendingToolContext>("public-1");
    expect(claimed.outcome).toBe("resolved");
    expect(claimed.context?.provider).toBe("claude");
    expect(broker.activeCount()).toBe(0);
    console.log("BROKER_CLIENT_NEUTRAL=PASS");
  });

  it("a legacy-shaped key with a client field still works (ignored, not required)", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(legacyShapedKey(), 5_000);
    expect(broker.claimByPublicToolCallId("public-legacy").outcome).toBe("resolved");
  });

  it("BROKER_CORRELATION_ISOLATION: concurrent entries never cross-resolve", () => {
    const broker = new DeferredToolBroker();
    const first = createPublicToolCallId("claude");
    const second = createPublicToolCallId("claude");

    broker.createPendingCall(
      neutralKey({ sessionId: "s1", toolCallId: first, publicToolCallId: first }),
      5_000,
      undefined,
      { provider: "claude", providerSession: "s1" } satisfies PendingToolContext,
    );
    broker.createPendingCall(
      neutralKey({ sessionId: "s2", toolCallId: second, publicToolCallId: second }),
      5_000,
      undefined,
      { provider: "claude", providerSession: "s2" } satisfies PendingToolContext,
    );
    expect(broker.activeCount()).toBe(2);

    const claimed = broker.claimByPublicToolCallId<PendingToolContext>(first);
    expect(claimed.outcome).toBe("resolved");
    expect(claimed.context?.providerSession).toBe("s1");
    // The other entry is untouched and still resolvable.
    expect(broker.activeCount()).toBe(1);
    expect(broker.claimByPublicToolCallId<PendingToolContext>(second).context?.providerSession).toBe(
      "s2",
    );
    console.log("BROKER_CORRELATION_ISOLATION=PASS");
  });

  it("reveals nothing about a foreign or guessed public id", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(neutralKey(), 5_000, undefined, { provider: "claude" });
    expect(broker.claimByPublicToolCallId("not-a-real-id").outcome).toBe("unknown");
    expect(broker.activeCount()).toBe(1);
  });

  it("preserves duplicate, stale and cancellation semantics", () => {
    const broker = new DeferredToolBroker();
    broker.createPendingCall(neutralKey(), 5_000, undefined, { provider: "claude" });

    expect(broker.claimByPublicToolCallId("public-1").outcome).toBe("resolved");
    // A second delivery of the same id is a duplicate, never a fresh resolve.
    expect(broker.claimByPublicToolCallId("public-1").outcome).toBe("duplicate");

    const cancelledId = createPublicToolCallId("google");
    broker.createPendingCall(
      neutralKey({ provider: "google", sessionId: "s9", toolCallId: cancelledId, publicToolCallId: cancelledId }),
      5_000,
      undefined,
      { provider: "google" },
    );
    broker.cancelScope({ provider: "google", sessionId: "s9" });
    expect(broker.claimByPublicToolCallId(cancelledId).outcome).toBe("stale");
    expect(broker.activeCount()).toBe(0);
  });

  it("the broker source declares no client identity property", () => {
    const source = readFileSync(join(REPO, "src/core/deferred-tool-broker.ts"), "utf-8");
    expect(source).not.toMatch(/consumer\s*:/);
    expect(source.toLowerCase()).not.toContain("qoder");
  });
});
