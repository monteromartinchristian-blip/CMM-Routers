import { describe, expect, it } from "vitest";
import {
  AntigravityAdapter,
  feedStreamLine,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function makeRequest(requestId = "agy-timing-1"): RouterRequest {
  return {
    requestId,
    model: {
      id: "google/some-model",
      provider: "google",
      upstreamModel: "some-model",
      displayName: "Some",
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
  };
}

/**
 * Race-proof timing double: emits the first text event, then waits on a
 * promise controlled BY THE TEST. The test awaits iterator.next(), asserts
 * the first Router delta arrived, and only then releases completion.
 */
function makeGatedStream(gate: Promise<void>) {
  const firstLine = JSON.stringify({
    event: "step_update",
    step_update: { text_delta: "early" },
  });
  const secondLine = JSON.stringify({
    event: "result",
    result: { status: "SUCCESS" },
  });
  return {
    async streamInference(
      _args: string[],
      options: { cwd: string; timeoutMs: number; signal: AbortSignal },
      onEvent: (event: ParsedStreamEvent) => void,
    ) {
      void options;
      feedStreamLine(firstLine, onEvent);
      await gate;
      feedStreamLine(secondLine, onEvent);
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
    async runInference() {
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

describe("Antigravity true incremental streaming", () => {
  it("yields the first Router delta while upstream is still blocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new AntigravityAdapter(
      makeGatedStream(gate) as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    const iterator = adapter.run(makeRequest(), new AbortController().signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "text_delta", text: "early" });
    console.log("ANTIGRAVITY_FIRST_ROUTER_DELTA_BEFORE_UPSTREAM_COMPLETION=YES");

    // Upstream is still blocked behind the test-controlled gate. Prove it:
    // the next event must not arrive until we release.
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
    expect(second.value).toMatchObject({ type: "completed" });
  });
});
