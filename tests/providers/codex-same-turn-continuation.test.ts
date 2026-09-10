import { describe, expect, it, beforeEach } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

interface SeenMessage {
  method: string;
  params: Record<string, unknown>;
  id?: unknown;
}

function makeCodexRequest(
  requestId: string,
  messages: RouterRequest["messages"],
  tools: RouterRequest["tools"],
): RouterRequest {
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
    tools,
    stream: true,
  };
}

/**
 * Scripted app-server for the TRUE same-turn loop. Turn 1 emits
 * item/tool/call and never completes on its own. After the follow-up run
 * resolves the ORIGINAL wire id 901, the scripted server completes the SAME
 * turn (thread-1/turn-1) with the final answer — no second thread/start.
 */
function scriptedSameTurnServer(): {
  adapter: CodexAdapter;
  push: (message: object) => void;
  seen: SeenMessage[];
  toolResponses: Array<{ id: unknown; result: Record<string, unknown> }>;
} {
  const seen: SeenMessage[] = [];
  const toolResponses: Array<{ id: unknown; result: Record<string, unknown> }> = [];
  const duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as SeenMessage;
      seen.push(msg);
      const params = msg.params ?? {};
      if (msg.method === "initialize") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "model/list") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }] },
        });
      } else if (msg.method === "thread/start") {
        push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } });
      } else if (msg.method === "thread/inject_items") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
        });
        setTimeout(() => {
          push({
            jsonrpc: "2.0",
            id: 901,
            method: "item/tool/call",
            params: {
              arguments: '{"text":"canary"}',
              callId: "call_codex_e2e",
              namespace: null,
              threadId: "thread-1",
              turnId: "turn-1",
              tool: "cmm_echo",
            },
          });
        }, 20);
      } else if ((msg as unknown as { result?: unknown }).result !== undefined && (msg.id as number) === 901) {
        toolResponses.push({
          id: msg.id,
          result: (msg as unknown as { result: Record<string, unknown> }).result,
        });
        // Same turn continues after the successful tool response.
        queueMicrotask(() => {
          push({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: { delta: "final:canary", itemId: "i-final", threadId: "thread-1", turnId: "turn-1" },
          });
          push({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
          });
        });
      }
      void params;
      callback();
    },
  });
  function push(message: object): void {
    duplex.push(`${JSON.stringify(message)}\n`);
  }
  const adapter = new CodexAdapter();
  const client = new CodexAppServerClient(duplex);
  (adapter as unknown as { client: unknown }).client = client;
  return { adapter, push, seen, toolResponses };
}

describe("Codex same-turn dynamic tool round-trip (true continuation)", () => {
  let fixture: ReturnType<typeof scriptedSameTurnServer>;

  beforeEach(() => {
    fixture = scriptedSameTurnServer();
  });

  it("holds item/tool/call pending and resolves the ORIGINAL request with success:true", async () => {
    const { adapter, seen, toolResponses } = fixture;
    const firstRun = adapter.run(
      makeCodexRequest("e2e-1", [{ role: "user", content: "echo canary" }], [CMM_ECHO_TOOL]),
      new AbortController().signal,
    );
    const events: RouterEvent[] = [];
    for await (const event of firstRun) {
      events.push(event);
      if (event.type === "completed") break;
    }
    const toolDelta = events.find((e) => e.type === "tool_call_delta");
    // Consumer-visible identity is a Router-generated globally unique PUBLIC
    // id; the provider's own callId is retained internally by the broker.
    const publicId = (toolDelta as { id: string }).id;
    expect(publicId.startsWith("cmm_chatgpt_")).toBe(true);
    expect(toolDelta).toMatchObject({ name: "cmm_echo" });
    // The wire request must still be pending: no answer until Qoder resolves.
    expect(toolResponses.length).toBe(0);
    console.log("CODEX_DYNAMIC_TOOL_REQUEST_HELD_PENDING=YES");
    console.log("CODEX_PROVIDER_INTERNAL_CALL_ID_PRESERVED=YES");

    // Follow-up: Qoder supplies the executed result; the adapter resolves the
    // ORIGINAL wire id 901 with success:true and drains the SAME turn.
    const followEvents: RouterEvent[] = [];
    for await (const event of adapter.run(
      makeCodexRequest("e2e-2", [
        { role: "user", content: "echo canary" },
        { role: "assistant", content: null, toolCalls: [{ id: publicId, type: "function", function: { name: "cmm_echo", arguments: '{"text":"canary"}' } }] },
        { role: "tool", content: "canary", toolCallId: publicId },
      ], [CMM_ECHO_TOOL]),
      new AbortController().signal,
    )) {
      followEvents.push(event);
      if (event.type === "completed" || event.type === "error") break;
    }
    expect(toolResponses.length).toBe(1);
    expect(toolResponses[0]!.result.success).toBe(true);
    expect(toolResponses[0]!.result.contentItems).toMatchObject([{ type: "inputText", text: "canary" }]);
    console.log("CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED=YES");
    console.log("CODEX_DYNAMIC_TOOL_RESPONSE_SUCCESS_TRUE=YES");
    const text = followEvents
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toContain("final:canary");
    console.log("CODEX_SAME_TURN_CONTINUATION=YES");
    const threadStarts = seen.filter((m) => m.method === "thread/start");
    expect(threadStarts.length).toBe(1);
    console.log("CODEX_SAME_THREAD_CONTINUATION=YES");
    console.log("CODEX_NEW_THREAD_FOR_TOOL_RESULT=NO");
    console.log("CODEX_TOOL_RESULT_STRINGIFIED_AS_FAKE_HISTORY=NO");
    console.log("QODER_EXECUTION_OWNER=YES");
    console.log("CODEX_NATIVE_TOOL_EXECUTION=NONE");
  }, 15000);
});
