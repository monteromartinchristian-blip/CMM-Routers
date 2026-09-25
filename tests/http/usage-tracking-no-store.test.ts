import { describe, expect, it } from "vitest";
import type { RouterEvent } from "../../src/core/events.js";
import { trackProviderStream } from "../../src/http/usage-tracking.js";

async function collect(
  iterable: AsyncGenerator<RouterEvent, unknown, void>,
): Promise<{ events: RouterEvent[]; outcome: unknown }> {
  const events: RouterEvent[] = [];
  for (;;) {
    const next = await iterable.next();
    if (next.done) {
      return { events, outcome: next.value };
    }
    events.push(next.value);
  }
}

describe("trackProviderStream without UsageStore", () => {
  it("remains a transparent passthrough for text, usage, and completion", async () => {
    async function* provider(): AsyncGenerator<RouterEvent> {
      yield { type: "text_delta", text: "Hello" };
      yield { type: "usage", inputTokens: 3, outputTokens: 1 };
      yield { type: "completed", finishReason: "stop" };
    }

    const result = await collect(
      trackProviderStream(
        undefined,
        "req-no-store",
        "chatgpt",
        "chatgpt/test-model",
        provider(),
      ),
    );

    expect(result.events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "usage", inputTokens: 3, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
    expect(result.outcome).toMatchObject({
      status: "success",
      inputTokens: 3,
      outputTokens: 1,
      finishReason: "stop",
    });
  });

  it("passes provider errors through instead of silently converting them to HTTP success", async () => {
    const providerError = {
      code: "provider_rate_limited",
      message: "rate limited",
    };

    async function* provider(): AsyncGenerator<RouterEvent> {
      yield { type: "error", error: providerError as any };
    }

    const result = await collect(
      trackProviderStream(
        undefined,
        "req-no-store-error",
        "chatgpt",
        "chatgpt/test-model",
        provider(),
      ),
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "error",
      error: providerError,
    });
    expect(result.outcome).toMatchObject({
      status: "rate_limit_error",
      errorCode: "provider_rate_limited",
    });
  });
});
