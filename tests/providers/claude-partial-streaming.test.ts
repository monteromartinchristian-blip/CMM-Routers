import { describe, expect, it, vi, beforeEach } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  startup: vi.fn(),
  resolveSettings: vi.fn(),
}));

import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function makeRequest(requestId = "stream-timing-1"): RouterRequest {
  return {
    requestId,
    model: {
      id: "claude/sonnet",
      provider: "claude",
      upstreamModel: "sonnet",
      displayName: "Sonnet",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

function streamEvent(text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  };
}

function successResult() {
  return {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 3, output_tokens: 5 },
  };
}

/**
 * Deterministic SDK double: partial text A at t0, then waits on a gate
 * controlled BY THE TEST, then partial text B, then terminal result.
 * The consumer must observe the first Router delta while the fake upstream
 * is still blocked behind the gate.
 */
function makeGatedStream(gate: Promise<void>) {
  async function* messages() {
    yield streamEvent("A");
    await gate;
    yield streamEvent("B");
    yield successResult();
  }
  return {
    supportedModels: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: () => messages(),
  };
}

describe("Claude incremental partial streaming", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("requests partial messages from the SDK", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryMock.mockReturnValue(makeGatedStream(gate));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.run(makeRequest(), new AbortController().signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "text_delta", text: "A" });
    release();
    for await (const _ of { [Symbol.asyncIterator]: () => iterator }) {
      // drain
    }
    const passedOptions = queryMock.mock.calls[0]?.[0]?.options as
      | Record<string, unknown>
      | undefined;
    expect(passedOptions?.includePartialMessages).toBe(true);
  });

  it("emits the first Router delta before upstream completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryMock.mockReturnValue(makeGatedStream(gate));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.run(makeRequest(), new AbortController().signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "text_delta" });
    console.log("CLAUDE_FIRST_ROUTER_DELTA_BEFORE_UPSTREAM_COMPLETION=YES");

    // Upstream is still blocked behind the test-controlled gate here: the
    // fake has yielded only A and is awaiting release. Prove it by checking
    // the second delta only arrives after we release.
    let secondArrived = false;
    const secondPromise = iterator.next().then((r) => {
      secondArrived = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondArrived).toBe(false);
    release();
    const second = await secondPromise;
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ type: "text_delta", text: "B" });

    const rest: unknown[] = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      rest.push(event);
    }
    const types = rest.map((e) => (e as { type: string }).type);
    expect(types.filter((t) => t === "completed").length).toBe(1);
    const texts = [first.value, second.value, ...rest]
      .filter((e) => (e as { type: string }).type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    // No duplication of partial text from a final assistant echo.
    expect(texts).toBe("AB");
  });

  it("never duplicates partial text when a final assistant message follows", async () => {
    async function* messages() {
      yield streamEvent("A");
      yield streamEvent("B");
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "AB" }] },
      };
      yield successResult();
    }
    queryMock.mockReturnValue({
      supportedModels: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: () => messages(),
    });
    const adapter = new ClaudeAdapter();
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event as { type: string; text?: string });
    }
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text ?? "")
      .join("");
    expect(texts).toBe("AB");
    expect(events.filter((e) => e.type === "completed").length).toBe(1);
  });

  it("still honours cancellation with partial streaming enabled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryMock.mockReturnValue(makeGatedStream(gate));
    const adapter = new ClaudeAdapter();
    const controller = new AbortController();
    const collected: unknown[] = [];
    const runPromise = (async () => {
      for await (const event of adapter.run(makeRequest(), controller.signal)) {
        collected.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    release();
    await runPromise;
    expect(collected.filter((e) => (e as { type: string }).type === "completed")).toEqual([]);
  });
});
