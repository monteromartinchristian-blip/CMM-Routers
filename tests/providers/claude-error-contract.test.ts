import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { RouterError } from "../../src/core/errors.js";
import type { RouterEvent } from "../../src/core/events.js";
import type { RouterRequest } from "../../src/core/provider.js";

/**
 * P1 contract: an SDK result with `is_error: true` is a provider failure even
 * when its subtype is `success`. The SDK documents exactly that shape for a
 * turn that ended on an API error (expired OAuth, quota, permission), and the
 * Router used to report it as a completed HTTP 200.
 */

function request(id = "claude-error-1"): RouterRequest {
  return {
    requestId: id,
    profile: "AGENT",
    model: {
      id: "claude/claude-sonnet-5",
      provider: "claude",
      upstreamModel: "claude-sonnet-5",
      displayName: "Sonnet 5",
      capability: "CHAT_AND_TOOLS",
    },
    messages: [{ role: "user", content: "hola" }],
    tools: [],
    stream: true,
  };
}

function adapterYielding(messages: readonly unknown[] | (() => AsyncGenerator<unknown>)): ClaudeAdapter {
  const queryFn = () => ({
    async *[Symbol.asyncIterator]() {
      if (typeof messages === "function") {
        yield* messages();
        return;
      }
      for (const message of messages) yield message;
    },
    close() {},
  });
  return new ClaudeAdapter({
    queryFn: queryFn as never,
    profileDir: "/tmp/cmm-router-test-profile",
  });
}

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function errorCode(events: RouterEvent[]): string | undefined {
  const failure = events.find((event) => event.type === "error") as
    | { error?: unknown }
    | undefined;
  return failure?.error instanceof RouterError ? failure.error.code : undefined;
}

describe("Claude SDK result contract", () => {
  it("IS_ERROR_TRUE_IS_AN_ERROR: success subtype with is_error is not a completed response", async () => {
    const adapter = adapterYielding([
      { type: "result", subtype: "success", is_error: true, result: "OAuth token expired" },
    ]);
    const events = await collect(adapter.run(request(), new AbortController().signal));
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(errorCode(events)).toBe("provider_auth_required");
    console.log("SDK_IS_ERROR_TRUE_REJECTED_AS_SUCCESS=PASS");
  });

  it("expired session maps to authentication, never to fake content", async () => {
    const adapter = adapterYielding([
      { type: "result", subtype: "success", is_error: true, result: "Your session has expired. Run /login" },
    ]);
    const events = await collect(adapter.run(request("claude-error-2"), new AbortController().signal));
    expect(errorCode(events)).toBe("provider_auth_required");
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
    console.log("EXPIRED_SESSION_IS_AUTH_ERROR=PASS");
  });

  it("quota, permission and unavailability keep distinct codes", async () => {
    const cases: Array<[string, string]> = [
      ["API Error: 429 rate limit exceeded", "provider_rate_limited"],
      ["403 permission denied for this model", "provider_permission_denied"],
      ["503 service unavailable", "provider_unavailable"],
      ["usage limit reached for this account", "provider_quota_exhausted"],
    ];
    for (const [text, expected] of cases) {
      const adapter = adapterYielding([
        { type: "result", subtype: "success", is_error: true, result: text },
      ]);
      const events = await collect(adapter.run(request(`claude-error-${expected}`), new AbortController().signal));
      expect(errorCode(events), text).toBe(expected);
    }
    console.log("PROVIDER_ERROR_CODES_DISTINCT=PASS");
  });

  it("a genuine success result completes and is never an error", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "hola" }] } },
      { type: "result", subtype: "success", is_error: false, result: "hola" },
    ]);
    const events = await collect(adapter.run(request("claude-ok"), new AbortController().signal));
    expect(events.some((event) => event.type === "completed")).toBe(true);
    expect(errorCode(events)).toBeUndefined();
    expect(events.find((event) => event.type === "text_delta")).toMatchObject({ text: "hola" });
    console.log("GENUINE_SUCCESS_COMPLETES=PASS");
  });

  it("model text that merely mentions auth is not misclassified", async () => {
    const adapter = adapterYielding([
      { type: "assistant", message: { content: [{ type: "text", text: "the author wrote about authentication" }] } },
      { type: "result", subtype: "success", is_error: false, result: "the author wrote about authentication" },
    ]);
    const events = await collect(adapter.run(request("claude-text"), new AbortController().signal));
    expect(errorCode(events)).toBeUndefined();
    expect(events.some((event) => event.type === "completed")).toBe(true);
    console.log("MODEL_TEXT_NOT_AN_ERROR=PASS");
  });

  it("an unrecognised terminal subtype fails closed instead of claiming success", async () => {
    const adapter = adapterYielding([
      { type: "result", subtype: "something_new", is_error: false, result: "?" },
    ]);
    const events = await collect(adapter.run(request("claude-unknown"), new AbortController().signal));
    expect(errorCode(events)).toBe("provider_protocol_error");
    console.log("UNKNOWN_RESULT_SUBTYPE_FAILS_CLOSED=PASS");
  });

  it("a thrown 401 is classified as an authentication failure", async () => {
    const adapter = adapterYielding(async function* (): AsyncGenerator<unknown> {
      throw new Error("API Error: 401 Unauthorized");
      // eslint-disable-next-line no-unreachable
      yield undefined;
    });
    const events = await collect(adapter.run(request("claude-throw"), new AbortController().signal));
    expect(errorCode(events)).toBe("provider_auth_required");
    console.log("THROWN_401_IS_AUTH_ERROR=PASS");
  });
});
