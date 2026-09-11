import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

interface Seen {
  method: string;
  params: Record<string, unknown>;
  id?: unknown;
  result?: Record<string, unknown>;
}

/**
 * Multi-thread scripted app-server. Every turn emits an `item/tool/call`
 * carrying the SAME provider callId ("dup-1") so the test can prove that two
 * simultaneous sessions never collide on provider identity. Each turn is
 * answered on its own wire id, and the server records what arrived.
 */
function multiThreadServer(providerCallId: string): {
  makeAdapter: (broker: DeferredToolBroker) => CodexAdapter;
  answers: Array<{ wireId: unknown; text: string }>;
  threadStarts: () => number;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const answers: Array<{ wireId: unknown; text: string }> = [];
  let threadSeq = 0;
  let turnSeq = 0;
  const turnByThread = new Map<string, { turnId: string; wireId: number }>();
  let wireSeq = 900;

  const transport = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as Seen;
      seen.push(msg);
      const params = msg.params ?? {};
      if (msg.method === "initialize") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        threadSeq += 1;
        push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: `thread-${threadSeq}` } } });
      } else if (msg.method === "thread/inject_items") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        turnSeq += 1;
        const threadId = String(params.threadId);
        const turnId = `turn-${turnSeq}`;
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: turnId, status: "inProgress", items: [] } },
        });
        const wireId = ++wireSeq;
        turnByThread.set(threadId, { turnId, wireId });
        // Give the client a beat to process the turn/start result and register
        // its scoped tool-call waiter before the tool call frame arrives.
        setTimeout(() => {
          push({
            jsonrpc: "2.0",
            id: wireId,
            method: "item/tool/call",
            params: {
              arguments: '{"text":"canary"}',
              callId: providerCallId,
              namespace: null,
              threadId,
              turnId,
              tool: "cmm_echo",
            },
          });
        }, 10);
      } else if (msg.result !== undefined && typeof msg.id === "number" && msg.id > 900) {
        const text = (() => {
          const items = (msg.result as { contentItems?: Array<{ text?: string }> }).contentItems;
          return items?.[0]?.text ?? "";
        })();
        answers.push({ wireId: msg.id, text });
        // Complete the owning turn so drainTurn terminates.
        for (const [threadId, info] of turnByThread) {
          if (info.wireId === msg.id) {
            setTimeout(() => {
              push({
                jsonrpc: "2.0",
                method: "item/agentMessage/delta",
                params: { delta: `final:${info.turnId}`, itemId: "i", threadId, turnId: info.turnId },
              });
              push({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: { threadId, turn: { id: info.turnId, status: "completed", items: [] } },
              });
            }, 5);
          }
        }
      }
      callback();
    },
  });

  function push(message: object): void {
    transport.push(`${JSON.stringify(message)}\n`);
  }

  return {
    makeAdapter: (broker: DeferredToolBroker) =>
      new CodexAdapter({ transportFactory: () => transport, broker }),
    answers,
    threadStarts: () => seen.filter((m) => m.method === "thread/start").length,
    seen,
  };
}

function request(requestId: string, messages: RouterRequest["messages"]): RouterRequest {
  return {
    requestId,
    model: {
      id: "chatgpt/gpt-5",
      provider: "chatgpt",
      upstreamModel: "gpt-5",
      displayName: "GPT-5",
      capability: "CHAT_AND_TOOLS",
    },
    messages,
    tools: [CMM_ECHO_TOOL],
    stream: true,
  };
}

async function collect(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) {
    out.push(event);
    if (event.type === "completed" || event.type === "error") break;
  }
  return out;
}

describe("Codex production broker: adversarial correlation", () => {
  it("isolates two simultaneous sessions that share a provider callId", async () => {
    const server = multiThreadServer("dup-1");
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    const adapter = server.makeAdapter(broker);

    const [eventsA, eventsB] = await Promise.all([
      (async () => {
        const p = collect(adapter.run(request("a", [{ role: "user", content: "echo" }]), new AbortController().signal));
        await new Promise((r) => setTimeout(r, 25));
        return p;
      })(),
      (async () => {
        const p = collect(adapter.run(request("b", [{ role: "user", content: "echo" }]), new AbortController().signal));
        await new Promise((r) => setTimeout(r, 25));
        return p;
      })(),
    ]);

    const idA = (eventsA.find((e) => e.type === "tool_call_delta") as { id: string }).id;
    const idB = (eventsB.find((e) => e.type === "tool_call_delta") as { id: string }).id;
    expect(idA).not.toBe(idB);
    expect(broker.activeCount()).toBe(2);
    console.log("DUPLICATE_PROVIDER_CALL_ID_ISOLATION=PASS");

    const followA = collect(
      adapter.run(
        request("a2", [
          { role: "user", content: "echo" },
          { role: "tool", content: "RESULT-A", toolCallId: idA },
        ]),
        new AbortController().signal,
      ),
    );
    const followB = collect(
      adapter.run(
        request("b2", [
          { role: "user", content: "echo" },
          { role: "tool", content: "RESULT-B", toolCallId: idB },
        ]),
        new AbortController().signal,
      ),
    );
    await Promise.all([followA, followB]);

    const texts = server.answers.map((a) => a.text).sort();
    expect(texts).toEqual(["RESULT-A", "RESULT-B"]);
    expect(broker.activeCount()).toBe(0);
    console.log("BROKER_CROSS_REQUEST_ISOLATION=PASS");
  }, 15000);

  it("rejects a guessed public tool id and does not open a new provider thread", async () => {
    const server = multiThreadServer("dup-1");
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 5000 });
    const adapter = server.makeAdapter(broker);
    const events = await collect(
      adapter.run(
        request("g", [
          { role: "user", content: "echo" },
          { role: "tool", content: "guessed", toolCallId: "cmm_chatgpt_guessed" },
        ]),
        new AbortController().signal,
      ),
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(server.threadStarts()).toBe(0);
    console.log("GUESSED_TOOL_ID_REJECTED=PASS");
    console.log("NO_NEW_THREAD_FOR_UNKNOWN_TOOL_RESULT=PASS");
  }, 15000);

  it("bounds pending state and expires by TTL, and duplicate/late results are classified", async () => {
    const broker = new DeferredToolBroker({ maxPending: 2, defaultTtlMs: 30 });
    const key = (toolCallId: string) => ({
      consumer: "qoder" as const,
      provider: "chatgpt" as const,
      sessionId: "thread-1",
      toolCallId,
      publicToolCallId: toolCallId,
    });
    broker.createPendingCall(key("p1"), 30);
    broker.createPendingCall(key("p2"), 30);
    expect(() => broker.createPendingCall(key("p3"), 30)).toThrow();
    console.log("BROKER_PENDING_BOUND=PASS");

    expect(broker.claimByPublicToolCallId("p1").outcome).toBe("resolved");
    expect(broker.claimByPublicToolCallId("p1").outcome).toBe("duplicate");
    console.log("PRODUCTION_DUPLICATE_RESULT_REJECTED=PASS");

    await new Promise((r) => setTimeout(r, 45));
    expect(broker.claimByPublicToolCallId("p2").outcome).toBe("stale");
    expect(broker.activeCount()).toBe(0);
    console.log("BROKER_TTL=PASS");
    console.log("PRODUCTION_LATE_RESULT_REJECTED=PASS");
  }, 15000);

  it("releases pending correlation when the provider session is cancelled", async () => {
    const server = multiThreadServer("dup-1");
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 60_000 });
    const adapter = server.makeAdapter(broker);
    const events = await collect(
      adapter.run(request("c", [{ role: "user", content: "echo" }]), new AbortController().signal),
    );
    expect(events.find((e) => e.type === "tool_call_delta")).toBeDefined();
    expect(broker.activeCount()).toBe(1);

    broker.cancelScope({ provider: "chatgpt" });
    expect(broker.activeCount()).toBe(0);
    console.log("BROKER_PROVIDER_DEATH_CLEANUP=PASS");
    console.log("PRODUCTION_CROSS_RUN_CANCEL_ISOLATION=PASS");
  }, 15000);
});
