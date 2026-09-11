import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import type { RouterEvent } from "../../src/core/events.js";
import type { RouterRequest } from "../../src/core/model.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

interface SeenMessage {
  method?: string;
  params?: Record<string, unknown>;
  id?: unknown;
  result?: Record<string, unknown>;
}

function request(
  requestId: string,
  messages: RouterRequest["messages"],
): RouterRequest {
  return {
    requestId,
    model: {
      id: "chatgpt/test-model",
      provider: "chatgpt",
      upstreamModel: "test-model",
      displayName: "Test Model",
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

function fixture(emitDeltaBeforeCompleted: boolean): {
  adapter: CodexAdapter;
  seen: SeenMessage[];
} {
  const THREAD = "thread-item-completed";
  const TURN = "turn-item-completed";
  const WIRE = 901;
  const seen: SeenMessage[] = [];

  let duplex: Duplex;

  const push = (message: object): void => {
    duplex.push(`${JSON.stringify(message)}\n`);
  };

  duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as SeenMessage;
      seen.push(msg);

      if (msg.method === "initialize") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "thread/start") {
        push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: THREAD } } });
      } else if (msg.method === "thread/inject_items") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: TURN, status: "inProgress", items: [] } },
        });
        setTimeout(() => {
          push({
            jsonrpc: "2.0",
            id: WIRE,
            method: "item/tool/call",
            params: {
              arguments: '{"text":"canary"}',
              callId: "call-item-completed",
              namespace: null,
              threadId: THREAD,
              turnId: TURN,
              tool: "cmm_echo",
            },
          });
        }, 10);
      } else if (msg.id === WIRE && msg.result !== undefined) {
        const items = msg.result.contentItems as Array<{ text?: string }> | undefined;
        const resultText = items?.[0]?.text ?? "";
        const finalText = `final:${resultText}`;

        queueMicrotask(() => {
          if (emitDeltaBeforeCompleted) {
            push({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                delta: finalText,
                itemId: "agent-final",
                threadId: THREAD,
                turnId: TURN,
              },
            });
          }

          push({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: TURN,
              item: {
                type: "agentMessage",
                id: "agent-final",
                text: finalText,
                phase: "final_answer",
              },
              completedAtMs: 1,
            },
          });

          push({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: THREAD,
              turn: { id: TURN, status: "completed", items: [] },
            },
          });
        });
      }

      callback();
    },
  });

  const adapter = new CodexAdapter();
  const client = new CodexAppServerClient(duplex);
  (adapter as unknown as { client: unknown }).client = client;
  return { adapter, seen };
}

async function roundTrip(
  emitDeltaBeforeCompleted: boolean,
): Promise<{ text: string; threadStarts: number }> {
  const { adapter, seen } = fixture(emitDeltaBeforeCompleted);

  const first = await collect(
    adapter.run(
      request("ic-1", [{ role: "user", content: "echo canary" }]),
      new AbortController().signal,
    ),
  );

  const call = first.find((event) => event.type === "tool_call_delta") as
    | { id: string; name: string; argumentsDelta: string }
    | undefined;

  expect(call).toBeDefined();
  expect(call!.name).toBe("cmm_echo");

  const result = "RESULT_FROM_QODER_ITEM_COMPLETED";
  const follow = await collect(
    adapter.run(
      request("ic-2", [
        { role: "user", content: "echo canary" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: call!.id,
              type: "function",
              function: { name: call!.name, arguments: call!.argumentsDelta },
            },
          ],
        },
        { role: "tool", content: result, toolCallId: call!.id },
      ]),
      new AbortController().signal,
    ),
  );

  const text = follow
    .filter((event) => event.type === "text_delta")
    .map((event) => (event as { text: string }).text)
    .join("");

  return {
    text,
    threadStarts: seen.filter((msg) => msg.method === "thread/start").length,
  };
}

describe("Codex item/completed final agent-message fallback", () => {
  it(
    "uses authoritative item/completed agentMessage text when no delta arrives after the tool result",
    async () => {
      const result = await roundTrip(false);
      expect(result.text).toBe("final:RESULT_FROM_QODER_ITEM_COMPLETED");
      expect(result.threadStarts).toBe(1);
      console.log("CODEX_ITEM_COMPLETED_FINAL_FALLBACK=PASS");
      console.log("CODEX_ITEM_COMPLETED_SAME_THREAD=PASS");
    },
    15_000,
  );

  it(
    "does not duplicate authoritative item/completed text when the same item already streamed a delta",
    async () => {
      const result = await roundTrip(true);
      expect(result.text).toBe("final:RESULT_FROM_QODER_ITEM_COMPLETED");
      expect(result.threadStarts).toBe(1);
      console.log("CODEX_ITEM_COMPLETED_NO_DUPLICATE_TEXT=PASS");
    },
    15_000,
  );
});
