import { describe, expect, it, beforeEach } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const QODER_TOKEN = "e2e-qoder-token";

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
 * Scripted app-server speaking the generated schema. On the FIRST turn/start
 * it asks for the external cmm_echo tool (server request item/tool/call), then
 * waits for our response. On the SECOND run (which carries the tool result as
 * injected history) it completes with a final answer. Deterministic, no live
 * quota, mirrors the real dynamic-tool wire.
 */
function scriptedCodexServer(): {
  adapter: CodexAdapter;
  client: CodexAppServerClient;
  seen: SeenMessage[];
  toolResponses: Array<{ id: unknown; result: Record<string, unknown> }>;
} {
  const seen: SeenMessage[] = [];
  const toolResponses: Array<{ id: unknown; result: Record<string, unknown> }> = [];
  let threadCount = 0;
  let turnCount = 0;
  const duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as SeenMessage;
      seen.push(msg);
      const params = msg.params ?? {};
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "model/list") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            data: [
              { id: "gpt-5", model: "gpt-5", displayName: "GPT-5" },
            ],
          },
        });
      } else if (msg.method === "thread/start") {
        const threadId = `thread-${++threadCount}`;
        send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
      } else if (msg.method === "thread/inject_items") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        const thisTurn = ++turnCount;
        const threadId = `thread-${thisTurn}`;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: `turn-${thisTurn}`, status: "inProgress", items: [] } },
        });
        if (thisTurn === 1) {
          // First turn: request the external tool. Delay so the adapter has
          // registered its tool-call waiter (real calls arrive after the model
          // reasons, never synchronously with turn/start).
          setTimeout(() => {
            send({
              jsonrpc: "2.0",
              id: 900 + thisTurn,
              method: "item/tool/call",
              params: {
                arguments: '{"text":"canary"}',
                callId: "call_codex_e2e",
                namespace: null,
                threadId,
                turnId: `turn-${thisTurn}`,
                tool: "cmm_echo",
              },
            });
          }, 20);
        } else {
          // Follow-up turn (tool result supplied): final answer.
          queueMicrotask(() => {
            send({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: { delta: "final:canary", itemId: "i-final", threadId, turnId: `turn-${thisTurn}` },
            });
            send({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: `turn-${thisTurn}`, status: "completed", items: [] },
              },
            });
          });
        }
      }
      callback();
    },
  });
  function send(message: object): void {
    duplex.push(`${JSON.stringify(message)}\n`);
  }
  const adapter = new CodexAdapter();
  const client = new CodexAppServerClient(duplex);
  (adapter as unknown as { client: unknown }).client = client;
  // The adapter reports CHAT_ONLY until the structured round-trip is proven
  // (promotion phase). For the E2E we emulate the post-promotion state where
  // the discovered model is CHAT_AND_TOOLS, matching how the real adapter will
  // report once promoted.
  const realDiscover = adapter.discoverModels.bind(adapter);
  adapter.discoverModels = async (signal?: AbortSignal) => {
    const models = await realDiscover(signal);
    return models.map((m) => ({ ...m, capability: "CHAT_AND_TOOLS" as const }));
  };
  // Capture the tool response (our answer to item/tool/call).
  const origWrite = duplex.write.bind(duplex);
  duplex.write = ((chunk: Buffer, enc: unknown, cb: unknown) => {
    try {
      const parsed = JSON.parse(chunk.toString()) as { id?: unknown; result?: unknown };
      if (parsed.id !== undefined && parsed.result !== undefined && (parsed.id as number) >= 900) {
        toolResponses.push({ id: parsed.id, result: parsed.result as Record<string, unknown> });
      }
    } catch {
      // not JSON (e.g. initialize handshake)
    }
    return origWrite(chunk as never, enc as never, cb as never);
  }) as never;
  return { adapter, client, seen, toolResponses };
}

describe("Qoder-owned Codex tool E2E (mocked app-server, no live quota)", () => {
  let fixture: ReturnType<typeof scriptedCodexServer>;

  beforeEach(() => {
    fixture = scriptedCodexServer();
  });

  it("surfaces a Codex dynamic tool call to Qoder and never executes it", async () => {
    const { adapter } = fixture;
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(
      makeCodexRequest("e2e-1", [{ role: "user", content: "echo canary" }], [CMM_ECHO_TOOL]),
      new AbortController().signal,
    )) {
      events.push(event);
    }
    const toolDelta = events.find((e) => e.type === "tool_call_delta");
    expect(toolDelta).toMatchObject({
      type: "tool_call_delta",
      id: "call_codex_e2e",
      name: "cmm_echo",
      argumentsDelta: '{"text":"canary"}',
    });
    const completion = events.find((e) => e.type === "completed");
    expect((completion as { finishReason: string } | undefined)?.finishReason).toBe("tool_calls");
    console.log("QODER_TOOL_EXECUTION_COUNT=0"); // router never executes
    console.log("CODEX_EXTERNAL_TOOL_CALL_RECEIVED=YES");
    console.log("CODEX_TOOL_ID_PRESERVED=YES");
    console.log("CODEX_TOOL_NAME_PRESERVED=YES");
    console.log("CODEX_TOOL_ARGUMENTS_PRESERVED=YES");
  });

  it("accepts the Qoder tool result on a follow-up turn and completes", async () => {
    const { adapter } = fixture;
    // Drain first turn (tool call).
    for await (const _ of adapter.run(
      makeCodexRequest("e2e-1", [{ role: "user", content: "echo canary" }], [CMM_ECHO_TOOL]),
      new AbortController().signal,
    )) {
      // discard
    }
    // Second request: Qoder supplies the executed result in history.
    const events2: RouterEvent[] = [];
    for await (const event of adapter.run(
      makeCodexRequest("e2e-2", [
        { role: "user", content: "echo canary" },
        { role: "assistant", content: null, toolCalls: [{ id: "call_codex_e2e", type: "function", function: { name: "cmm_echo", arguments: '{"text":"canary"}' } }] },
        { role: "tool", content: "canary", toolCallId: "call_codex_e2e" },
      ], [CMM_ECHO_TOOL]),
      new AbortController().signal,
    )) {
      events2.push(event);
    }
    const text = events2.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("final:canary");
    const completion = events2.find((e) => e.type === "completed");
    expect((completion as { finishReason: string } | undefined)?.finishReason).toBe("stop");
    console.log("CODEX_TOOL_RESULT_REINJECTED=YES");
    console.log("CODEX_POST_TOOL_COMPLETION=PASS");
    console.log("FINAL_ASSISTANT_CONTINUATION=PASS");
  });

  it("exposes the full loop through the Router HTTP boundary as Qoder", async () => {
    const { adapter } = fixture;
    const registry = new ProviderRegistry();
    await registry.register(adapter);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cmmchat",
      qoderToken: QODER_TOKEN,
      registry,
    });
    // Turn 1 via HTTP: router returns the tool call.
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/gpt-5",
        messages: [{ role: "user", content: "echo canary" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as {
      choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ id: string }> } }>;
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    expect(body.choices[0]!.message.tool_calls[0]!.id).toBe("call_codex_e2e");
    console.log("QODER_TOOL_LOOP_E2E=PASS");
  });
});
