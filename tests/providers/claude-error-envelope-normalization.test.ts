/**
 * A provider refusal must not answer as a normal completion.
 *
 * The shape that motivated this: the runtime refuses a model, reports the
 * refusal as an assistant turn whose text is the error prose, and then closes
 * the turn with an envelope whose `subtype` is "success". A subtype-only check
 * reads that as a completed answer, so the caller gets HTTP 200 with the
 * provider's error message as the body.
 *
 * The fix reads structure, never wording. `is_error` is the field the SDK
 * itself keys off to decide a turn failed, and `api_error_status` is the
 * upstream status. Each test below would still pass if the prose were
 * reworded, which is the property that makes this a normalisation rather than
 * a string heuristic.
 */
import { describe, expect, it, vi } from "vitest";

import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { RouterEvent } from "../../src/core/events.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({ [Symbol.asyncIterator]: async function* () {} }),
  startup: async () => ({}),
  resolveSettings: () => ({}),
}));

const REFUSAL_PROSE =
  "API Error: 400 Claude Code 2.1.266 does not support this model; version 2.1.280 or newer is required.";

function adapter(): ClaudeAdapter {
  return new ClaudeAdapter({ broker: undefined as never });
}

/** Drive the private message pump with a scripted SDK message sequence. */
async function pump(messages: unknown[]): Promise<RouterEvent[]> {
  const instance = adapter();
  const process = (
    instance as unknown as {
      processSdkMessage: (
        message: unknown,
        state: {
          sawPartialDelta: boolean;
          usageYielded: boolean;
          pendingAssistantText: string | null;
        },
      ) => Generator<RouterEvent, boolean, void>;
    }
  ).processSdkMessage.bind(instance);
  const state = {
    sawPartialDelta: false,
    usageYielded: false,
    pendingAssistantText: null as string | null,
  };
  const events: RouterEvent[] = [];
  for (const message of messages) {
    for (const event of process(message, state)) events.push(event);
  }
  return events;
}

const errorEvent = (events: RouterEvent[]) =>
  events.find((event) => event.type === "error");

describe("a refusal the runtime reported inside a success envelope", () => {
  const sequence = [
    { type: "assistant", message: { content: [{ type: "text", text: REFUSAL_PROSE }] } },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      result: REFUSAL_PROSE,
    },
  ];

  it("becomes an error, not a completion", async () => {
    const events = await pump(sequence);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("never emits the refusal prose as answer text", async () => {
    const events = await pump(sequence);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).not.toContain("API Error");
  });

  it("classifies from the upstream status, not from the wording", async () => {
    const events = await pump(sequence);
    const error = errorEvent(events) as { error: { code: string } };
    // 400 is the provider's own statement; the text is not consulted.
    expect(error.error.code).toBe("invalid_request");
  });

  it("still detects the refusal if the prose is reworded to nothing recognisable", async () => {
    const events = await pump([
      { type: "assistant", message: { content: [{ type: "text", text: "zzz qqq" }] } },
      { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "zzz qqq" },
    ]);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("maps a 401 to an auth failure and a 429 to a quota failure", async () => {
    const auth = await pump([
      { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "x" },
    ]);
    expect((errorEvent(auth) as { error: { code: string } }).error.code).toBe(
      "provider_auth_required",
    );
    const quota = await pump([
      { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "x" },
    ]);
    expect((errorEvent(quota) as { error: { code: string } }).error.code).toBe(
      "provider_quota_exhausted",
    );
  });

  it("does not treat a genuinely successful turn as a failure", async () => {
    const events = await pump([
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" },
    ]);
    expect(errorEvent(events)).toBeUndefined();
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });

  it("delivers a successful turn's held text, so buffering loses nothing", async () => {
    const events = await pump([
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" },
    ]);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("ok");
  });

  it("leaves streaming deltas untouched: they never pass through the hold", async () => {
    const events = await pump([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
      { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" },
    ]);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("hi");
  });

  it("still honours an error subtype, which carries its reasons in errors[]", async () => {
    const events = await pump([
      { type: "result", subtype: "error_during_execution", errors: ["something broke"] },
    ]);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });
});