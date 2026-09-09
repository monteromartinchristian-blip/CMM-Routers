import { describe, expect, it } from "vitest";
import { UsageStore } from "../../src/observability/usage-store.js";

describe("UsageStore", () => {
  it("records only safe metadata, never prompts or secrets", () => {
    const store = new UsageStore();
    store.beginRequest("req-1", "google", "google/gemini-3.8-flash-low");
    const record = store.endRequest("req-1", {
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(record.requestId).toBe("req-1");
    expect(record.provider).toBe("google");
    expect(record.model).toBe("google/gemini-3.8-flash-low");
    expect(record.inputTokens).toBe(10);
    expect(record.outputTokens).toBe(5);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("Authorization");
    const keys = Object.keys(record);
    for (const forbidden of [
      "prompt",
      "completion",
      "messages",
      "file",
      "toolArgs",
      "authorization",
      "secret",
      "oauth",
      "token",
      "email",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("bounds the buffer to the last 500 requests", () => {
    const store = new UsageStore();
    for (let i = 0; i < 520; i++) {
      store.beginRequest(`req-${i}`, "google", "google/m");
      store.endRequest(`req-${i}`, { status: "success" });
    }
    expect(store.listRecent(600).length).toBe(500);
  });

  it("aggregates readiness, latency, and quota counters", () => {
    const store = new UsageStore();
    store.beginRequest("a", "google", "google/m");
    store.endRequest("a", { status: "success", inputTokens: 1, outputTokens: 1 });
    store.beginRequest("b", "claude", "claude/sonnet");
    store.endRequest("b", { status: "quota_error", errorCode: "provider_quota_exhausted" });
    store.beginRequest("c", "chatgpt", "chatgpt/m");
    store.endRequest("c", { status: "rate_limit_error", errorCode: "provider_rate_limited" });
    store.beginRequest("d", "google", "google/m");
    store.endRequest("d", { status: "timeout_error", errorCode: "provider_timeout" });
    const aggregates = store.aggregates();
    expect(aggregates.totalRequests).toBe(4);
    expect(aggregates.successCount).toBe(1);
    expect(aggregates.failureCount).toBe(3);
    expect(aggregates.quotaEvents).toBe(1);
    expect(aggregates.rateLimitEvents).toBe(1);
    expect(aggregates.timeoutEvents).toBe(1);
    expect(aggregates.lastSuccessAt).not.toBeNull();
    expect(aggregates.averageLatencyMs).not.toBeNull();
  });

  it("tracks active requests and active model", () => {
    const store = new UsageStore();
    store.beginRequest("live-1", "google", "google/m");
    const aggregates = store.aggregates();
    expect(aggregates.activeRequests).toBe(1);
    expect(aggregates.activeModel).toBe("google/m");
  });
});
