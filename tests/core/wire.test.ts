import { describe, expect, it } from "vitest";
import {
  parseEventEnvelope,
  parseRequestEnvelope,
  safeRouterError,
  serializeEnvelope,
  type WorkerEventEnvelope,
  type WorkerRequestEnvelope,
} from "../../src/core/wire.js";
import { RouterError } from "../../src/core/errors.js";

const REQUEST: WorkerRequestEnvelope = {
  version: 1,
  requestId: "req-1",
  provider: "google",
  operation: "run",
  payload: {
    requestId: "req-1",
    model: {
      id: "google/gemini-3.8-flash-low",
      provider: "google",
      upstreamModel: "gemini-3.8-flash-low",
      displayName: "Flash Low",
    },
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
  },
};

describe("remote worker wire contract", () => {
  it("round-trips request envelopes deterministically", () => {
    const a = serializeEnvelope(REQUEST);
    const b = serializeEnvelope(JSON.parse(a));
    expect(a).toBe(b);
    expect(parseRequestEnvelope(a)).toEqual(REQUEST);
  });

  it("round-trips every event variant", () => {
    const variants: WorkerEventEnvelope["event"][] = [
      { type: "text_delta", text: "hi" },
      { type: "tool_call_delta", index: 0, id: "c1", name: "cmm_echo", argumentsDelta: "{}" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
      { type: "error", error: { code: "provider_timeout" } },
    ];
    variants.forEach((event, sequence) => {
      const envelope: WorkerEventEnvelope = { version: 1, requestId: "req-1", sequence, event };
      expect(parseEventEnvelope(serializeEnvelope(envelope))).toEqual(envelope);
    });
  });

  it("rejects unknown protocol versions", () => {
    expect(() =>
      parseRequestEnvelope(JSON.stringify({ ...REQUEST, version: 2 })),
    ).toThrow(RouterError);
    expect(() =>
      parseEventEnvelope(JSON.stringify({ version: 99, requestId: "r", sequence: 0, event: { type: "completed", finishReason: "stop" } })),
    ).toThrow(RouterError);
  });

  it("rejects unknown messages", () => {
    expect(() =>
      parseRequestEnvelope(JSON.stringify({ ...REQUEST, operation: "teleport" })),
    ).toThrow(RouterError);
    expect(() =>
      parseRequestEnvelope(JSON.stringify({ ...REQUEST, provider: "qwen" })),
    ).toThrow(RouterError);
    expect(() => parseEventEnvelope("not json")).toThrow(RouterError);
  });

  it("preserves correlation across an ordered event stream", () => {
    const events: WorkerEventEnvelope[] = [0, 1, 2].map((sequence) => ({
      version: 1,
      requestId: "req-9",
      sequence,
      event: { type: "text_delta", text: `t${sequence}` },
    }));
    const parsed = events.map((e) => parseEventEnvelope(serializeEnvelope(e)));
    expect(parsed.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(new Set(parsed.map((e) => e.requestId)).size).toBe(1);
  });

  it("serializes cancellation envelopes", () => {
    const cancel = { version: 1, requestId: "req-1", provider: "google" } as const;
    expect(() => serializeEnvelope(cancel)).not.toThrow();
  });

  it("produces safe errors without secrets", () => {
    const safe = safeRouterError(new RouterError("provider_rate_limited", "slow", { provider: "google" }));
    expect(safe).toEqual({ code: "provider_rate_limited", message: "slow", provider: "google" });
    expect(JSON.stringify(safe)).not.toContain("Bearer");
    const unknown = safeRouterError(new Error("boom"));
    expect(unknown.code).toBe("router_internal_error");
  });

  it("refuses envelopes carrying secrets", () => {
    expect(() =>
      serializeEnvelope({ ...REQUEST, payload: { authorization: "Bearer x" } }),
    ).toThrow(RouterError);
    expect(() =>
      serializeEnvelope({ version: 1, requestId: "r", sequence: 0, event: { type: "text_delta", text: "x", secret: "y" } }),
    ).toThrow(RouterError);
  });

  it("keeps payloads provider-neutral (no SDK/process objects)", () => {
    const serialized = serializeEnvelope(REQUEST);
    for (const forbidden of ["ChildProcess", "Duplex", "ApiKey", "keychain", "0.0.0.0"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("accepts backward-compatible extension fields", () => {
    const extended = JSON.stringify({ ...REQUEST, traceId: "trace-1" });
    expect(parseRequestEnvelope(extended).requestId).toBe("req-1");
  });
});
