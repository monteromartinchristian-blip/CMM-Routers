import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { FakeCodexTransport } from "../helpers/fake-codex-transport.js";

const DELTA = "item/agentMessage/delta";
const USAGE = "thread/tokenUsage/updated";
const DONE = "turn/completed";

function usageParams(threadId: string, turnId: string, outputTokens: number) {
  return {
    threadId,
    turnId,
    tokenUsage: {
      last: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens,
        reasoningOutputTokens: 0,
        totalTokens: 10 + outputTokens,
      },
      total: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens,
        reasoningOutputTokens: 0,
        totalTokens: 10 + outputTokens,
      },
    },
  };
}

describe("Codex concurrent notification isolation (production dispatcher)", () => {
  it("routes interleaved A/B events to their owning runs only", async () => {
    const transport = new FakeCodexTransport();
    const client = new CodexAppServerClient(transport);
    const methods = [DELTA, USAGE, DONE];

    const textsA: string[] = [];
    const textsB: string[] = [];
    const usageA: number[] = [];
    const usageB: number[] = [];
    let doneA = false;
    let doneB = false;

    const runA = (async () => {
      for (;;) {
        const n = await client.waitForAnyNotification(methods, 5000, {
          threadId: "thread-A",
          turnId: "turn-A",
        });
        const params = n.params as Record<string, unknown>;
        if (n.method === DELTA) textsA.push(String(params.delta));
        else if (n.method === USAGE) {
          usageA.push(Number((params.tokenUsage as Record<string, Record<string, number>>).last.outputTokens));
        } else if (n.method === DONE) {
          doneA = true;
          return;
        }
      }
    })();
    const runB = (async () => {
      for (;;) {
        const n = await client.waitForAnyNotification(methods, 5000, {
          threadId: "thread-B",
          turnId: "turn-B",
        });
        const params = n.params as Record<string, unknown>;
        if (n.method === DELTA) textsB.push(String(params.delta));
        else if (n.method === USAGE) {
          usageB.push(Number((params.tokenUsage as Record<string, Record<string, number>>).last.outputTokens));
        } else if (n.method === DONE) {
          doneB = true;
          return;
        }
      }
    })();

    // Deliberate interleave: B1, A1, B-usage, A2, A-done, B2, B-done.
    transport.receiveMessage({ jsonrpc: "2.0", method: DELTA, params: { delta: "B1", itemId: "i-b1", threadId: "thread-B", turnId: "turn-B" } });
    transport.receiveMessage({ jsonrpc: "2.0", method: DELTA, params: { delta: "A1", itemId: "i-a1", threadId: "thread-A", turnId: "turn-A" } });
    transport.receiveMessage({ jsonrpc: "2.0", method: USAGE, params: usageParams("thread-B", "turn-B", 20) });
    transport.receiveMessage({ jsonrpc: "2.0", method: DELTA, params: { delta: "A2", itemId: "i-a2", threadId: "thread-A", turnId: "turn-A" } });
    transport.receiveMessage({ jsonrpc: "2.0", method: DONE, params: { threadId: "thread-A", turn: { id: "turn-A", status: "completed", items: [] } } });
    transport.receiveMessage({ jsonrpc: "2.0", method: DELTA, params: { delta: "B2", itemId: "i-b2", threadId: "thread-B", turnId: "turn-B" } });
    transport.receiveMessage({ jsonrpc: "2.0", method: DONE, params: { threadId: "thread-B", turn: { id: "turn-B", status: "completed", items: [] } } });

    await Promise.all([runA, runB]);

    expect(textsA.join("")).toBe("A1A2");
    expect(textsB.join("")).toBe("B1B2");
    console.log("CODEX_REQUEST_A_TEXT=A1A2");
    console.log("CODEX_REQUEST_B_TEXT=B1B2");
    expect(usageA).toEqual([]);
    expect(usageB).toEqual([20]);
    console.log("CODEX_CROSS_THREAD_DELTA_LEAK=NONE");
    console.log("CODEX_CROSS_THREAD_USAGE_LEAK=NONE");
    console.log("CODEX_CROSS_THREAD_COMPLETION_LEAK=NONE");
    expect(doneA).toBe(true);
    expect(doneB).toBe(true);
  });

  it("timing out one scoped waiter leaves the other registered", async () => {
    const transport = new FakeCodexTransport();
    const client = new CodexAppServerClient(transport);
    const methods = [DELTA, DONE];

    const waiterB = client.waitForAnyNotification(methods, 5000, {
      threadId: "thread-B",
      turnId: "turn-B",
    });
    await expect(
      client.waitForAnyNotification(methods, 50, { threadId: "thread-A", turnId: "turn-A" }),
    ).rejects.toThrow(/Timeout/);

    // B's waiter must still be registered and resolvable.
    transport.receiveMessage({ jsonrpc: "2.0", method: DELTA, params: { delta: "B1", itemId: "i", threadId: "thread-B", turnId: "turn-B" } });
    const n = await waiterB;
    expect((n.params as Record<string, unknown>).threadId).toBe("thread-B");
    console.log("CODEX_CONCURRENT_NOTIFICATION_ISOLATION=PASS");
  });
});
