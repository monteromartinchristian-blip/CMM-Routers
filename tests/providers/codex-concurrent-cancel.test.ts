import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";

interface SeenMessage {
  method: string;
  params: Record<string, unknown>;
  id?: unknown;
}

function makeRequest(requestId: string): RouterRequest {
  return {
    requestId,
    model: {
      id: "chatgpt/gpt-5",
      provider: "chatgpt",
      upstreamModel: "gpt-5",
      displayName: "GPT-5",
    },
    messages: [{ role: "user", content: `prompt-${requestId}` }],
    tools: [],
    stream: true,
  };
}

/**
 * Scripted app-server that mirrors the generated schema shapes and assigns
 * deterministic thread/turn ids in first-come order (A then B).
 */
function scriptedServer(): { duplex: Duplex; seen: SeenMessage[] } {
  const seen: SeenMessage[] = [];
  const threadIds: string[] = [];
  const duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as SeenMessage;
      seen.push(msg);
      const params = msg.params ?? {};
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        const threadId = threadIds.length === 0 ? "thread-A" : "thread-B";
        threadIds.push(threadId);
        send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
      } else if (msg.method === "thread/inject_items") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        const threadId = String(params.threadId);
        const turnId = threadId === "thread-A" ? "turn-A" : "turn-B";
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: turnId, status: "inProgress", items: [] } },
        });
      } else if (msg.method === "turn/interrupt") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      callback();
    },
  });
  function send(message: object): void {
    duplex.push(`${JSON.stringify(message)}\n`);
  }
  return { duplex, seen };
}

function delta(threadId: string, turnId: string, text: string): object {
  return {
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { delta: text, itemId: `i-${text}`, threadId, turnId },
  };
}

describe("Codex concurrent cancel isolation (production adapter + dispatcher)", () => {
  it("cancels A without affecting B, and leaves no A state behind", async () => {
    const { duplex, seen } = scriptedServer();
    const adapter = new CodexAdapter();
    const client = new CodexAppServerClient(duplex);
    (adapter as unknown as { client: unknown }).client = client;
    await client.initialize({ clientInfo: { name: "t", version: "0" } });
    await client.sendInitializedNotification();

    const controllerA = new AbortController();
    const eventsA: RouterEvent[] = [];
    const eventsB: RouterEvent[] = [];
    const textsA: string[] = [];
    const textsB: string[] = [];

    // Start A first so the scripted server assigns it thread-A/turn-A.
    const runA = (async () => {
      for await (const event of adapter.run(makeRequest("req-A"), controllerA.signal)) {
        eventsA.push(event);
        if (event.type === "text_delta") textsA.push(event.text);
      }
    })();
    await waitFor(() => seen.some((m) => m.method === "turn/start" && m.params.threadId === "thread-A"));
    const runB = (async () => {
      for await (const event of adapter.run(makeRequest("req-B"), new AbortController().signal)) {
        eventsB.push(event);
        if (event.type === "text_delta") textsB.push(event.text);
      }
    })();
    await waitFor(() => seen.some((m) => m.method === "turn/start" && m.params.threadId === "thread-B"));

    // Interleave deltas for both live turns.
    duplex.push(`${JSON.stringify(delta("thread-A", "turn-A", "A1"))}\n`);
    duplex.push(`${JSON.stringify(delta("thread-B", "turn-B", "B1"))}\n`);
    duplex.push(`${JSON.stringify(delta("thread-A", "turn-A", "A2"))}\n`);
    duplex.push(`${JSON.stringify(delta("thread-B", "turn-B", "B2"))}\n`);
    await waitFor(() => textsA.length >= 2 && textsB.length >= 2);

    // Cancel A only (abort + cancel, exactly as the HTTP disconnect path does).
    controllerA.abort();
    await adapter.cancel("req-A");

    const interrupts = seen.filter((m) => m.method === "turn/interrupt");
    expect(interrupts.length).toBe(1);
    expect(interrupts[0]?.params.threadId).toBe("thread-A");
    expect(interrupts[0]?.params.turnId).toBe("turn-A");
    console.log("CODEX_CANCEL_A_TARGET_THREAD=thread-A");
    console.log("CODEX_CANCEL_A_TARGET_TURN=turn-A");

    // B keeps running and completes normally after A's cancellation.
    duplex.push(`${JSON.stringify(delta("thread-B", "turn-B", "B3"))}\n`);
    duplex.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-B", turn: { id: "turn-B", status: "completed", items: [] } },
      })}\n`,
    );
    await Promise.all([runA, runB]);

    expect(textsA.join("")).toBe("A1A2");
    expect(textsB.join("")).toBe("B1B2B3");
    expect(eventsA.some((e) => e.type === "completed")).toBe(false);
    expect(eventsB.filter((e) => e.type === "completed").length).toBe(1);
    console.log("CODEX_REQUEST_A_ABORTED=YES");
    console.log("CODEX_REQUEST_B_CONTINUES=YES");
    console.log("CODEX_REQUEST_B_COMPLETES=YES");
    console.log("CODEX_CANCEL_AFFECTED_B=NO");
    console.log("CODEX_CANCEL_SCOPING=PASS");

    // No waiter, active turn, or buffered notification may remain for A.
    const activeTurns = (adapter as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
    expect(activeTurns.size).toBe(0);
    const state = client as unknown as {
      notificationWaiters: Array<{ threadId?: string; turnId?: string }>;
      notificationQueue: Array<{ threadId?: string; turnId?: string; turnIdNested?: string }>;
    };
    expect(
      state.notificationWaiters.some((w) => w.threadId === "thread-A" || w.turnId === "turn-A"),
    ).toBe(false);
    expect(
      state.notificationQueue.some(
        (b) => b.threadId === "thread-A" || b.turnId === "turn-A" || b.turnIdNested === "turn-A",
      ),
    ).toBe(false);
    console.log("CODEX_CANCEL_A_STATE_CLEANUP=PASS");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
