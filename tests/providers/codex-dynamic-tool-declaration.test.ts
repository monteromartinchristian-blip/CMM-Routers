import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const EXPERIMENTAL = join(import.meta.dirname, "../fixtures/generated/codex-experimental-0.153.4");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(EXPERIMENTAL, name), "utf-8")) as Record<string, unknown>;
}

function makeRequest(requestId: string, tools: RouterRequest["tools"]): RouterRequest {
  return {
    requestId,
    model: {
      id: "chatgpt/gpt-5",
      provider: "chatgpt",
      upstreamModel: "gpt-5",
      displayName: "GPT-5",
      capability: "CHAT_AND_TOOLS",
    },
    messages: [{ role: "user", content: "echo canary" }],
    tools,
    stream: true,
  };
}

interface Seen {
  method: string;
  params: Record<string, unknown>;
  id?: unknown;
}

/**
 * Strict app-server double. It REFUSES thread/start unless the client first
 * enabled the experimental API and declared the exact expected dynamicTools.
 * `item/tool/call` is only ever synthesized after a valid declaration was
 * observed, so no test can pass by skipping the declaration step.
 */
function strictAppServer(expectedToolNames: string[]): {
  makeAdapter: () => CodexAdapter;
  seen: Seen[];
  toolCalls: Array<Record<string, unknown>>;
  initializedWithOptIn: () => boolean;
  declarationAccepted: () => boolean;
  emitToolCall: (params: Record<string, unknown>) => void;
} {
  const seen: Seen[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let optIn = false;
  let declared = false;
  let threadCounter = 0;

  function push(message: object): void {
    transport.push(`${JSON.stringify(message)}\n`);
  }

  const transport = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as Seen;
      seen.push(msg);
      const params = msg.params ?? {};
      if (msg.method === "initialize") {
        const capabilities = params.capabilities as Record<string, unknown> | undefined;
        optIn = capabilities?.experimentalApi === true;
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "model/list") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }] },
        });
      } else if (msg.method === "thread/start") {
        const dynamicTools = params.dynamicTools;
        const valid =
          optIn &&
          Array.isArray(dynamicTools) &&
          dynamicTools.length === expectedToolNames.length &&
          dynamicTools.every((spec, i) => {
            const s = spec as Record<string, unknown>;
            return (
              s.type === "function" &&
              s.name === expectedToolNames[i] &&
              typeof s.description === "string" &&
              s.inputSchema !== undefined &&
              s.deferLoading === false
            );
          });
        if (!valid) {
          push({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: "experimental API not enabled or dynamicTools invalid" },
          });
          return;
        }
        declared = true;
        threadCounter += 1;
        push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: `thread-${threadCounter}` } } });
      } else if (msg.method === "thread/inject_items") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "turn/start") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
        });
      }
      callback();
    },
  });

  function makeAdapter(): CodexAdapter {
    return new CodexAdapter({ transportFactory: () => transport });
  }

  function emitToolCall(params: Record<string, unknown>): void {
    // Guard: never let a test synthesize a tool call without a declaration.
    if (!declared) throw new Error("no valid dynamicTools declaration observed");
    toolCalls.push(params);
    push({
      jsonrpc: "2.0",
      id: 901,
      method: "item/tool/call",
      params: { namespace: null, threadId: "thread-1", turnId: "turn-1", ...params },
    });
  }

  return {
    makeAdapter,
    seen,
    toolCalls,
    initializedWithOptIn: () => optIn,
    declarationAccepted: () => declared,
    emitToolCall,
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

describe("Codex 0.153.4 experimental dynamic tools", () => {
  it("tracks the experimental schema fixture (dynamicTools present on ThreadStartParams)", () => {
    const tsp = fixture("ThreadStartParams.dynamicTools.json");
    const property = tsp.property as Record<string, unknown>;
    expect(property.type).toEqual(["array", "null"]);
    expect(property.default).toBeNull();
    const spec = fixture("DynamicToolSpec.json");
    const fn = (spec.oneOf as Array<Record<string, unknown>>)[0]!;
    expect((fn.properties as Record<string, unknown>).deferLoading).toBeDefined();
    expect(fn.required).toEqual(["description", "inputSchema", "name", "type"]);
    const capabilities = fixture("InitializeCapabilities.json");
    expect((capabilities.properties as Record<string, unknown>).experimentalApi).toMatchObject({
      type: "boolean",
      default: false,
    });
    console.log("CODEX_DYNAMIC_TOOLS_SCHEMA_TRACKED=PASS");
  });

  it("fails closed on a malformed declaration: missing callId and missing tool name", async () => {
    const server = strictAppServer(["cmm_echo"]);
    const adapter = server.makeAdapter();
    const runPromise = collect(adapter.run(makeRequest("r1", [CMM_ECHO_TOOL]), new AbortController().signal));
    await new Promise((r) => setTimeout(r, 30));
    server.emitToolCall({ arguments: '{"text":"canary"}' }); // no callId, no tool
    const events = await runPromise;
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    // No fabricated identity may be surfaced to the consumer.
    const surfaced = events.find((e) => e.type === "tool_call_delta");
    expect(surfaced).toBeUndefined();
    console.log("CODEX_MISSING_CALL_ID_FAIL_CLOSED=PASS");
    console.log("CODEX_MISSING_TOOL_NAME_FAIL_CLOSED=PASS");
    console.log("CODEX_PROVIDER_CALL_ID_FABRICATION=NONE");
  }, 15000);

  it("sends the experimental opt-in, declares Qoder tools, and only then allows a tool call", async () => {
    const server = strictAppServer(["cmm_echo"]);
    const adapter = server.makeAdapter();
    const runPromise = collect(adapter.run(makeRequest("r2", [CMM_ECHO_TOOL]), new AbortController().signal));
    await new Promise((r) => setTimeout(r, 40));

    const init = server.seen.find((m) => m.method === "initialize");
    expect(init).toBeDefined();
    expect((init!.params.capabilities as Record<string, unknown>).experimentalApi).toBe(true);
    expect(server.initializedWithOptIn()).toBe(true);
    console.log("CODEX_EXPERIMENTAL_API_OPT_IN=PASS");

    const threadStart = server.seen.find((m) => m.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect(threadStart!.params.dynamicTools).toEqual([
      {
        type: "function",
        name: "cmm_echo",
        description: "Return the supplied text unchanged.",
        inputSchema: CMM_ECHO_TOOL.function.parameters,
        deferLoading: false,
      },
    ]);
    expect(server.declarationAccepted()).toBe(true);
    console.log("CODEX_DYNAMIC_TOOLS_SENT=PASS");
    console.log("CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS");

    server.emitToolCall({ arguments: '{"text":"canary"}', callId: "call_codex_1", tool: "cmm_echo" });
    const events = await runPromise;
    const toolDelta = events.find((e) => e.type === "tool_call_delta");
    expect(toolDelta).toMatchObject({ name: "cmm_echo" });
    expect(server.toolCalls.length).toBe(1);
    console.log("CODEX_STRICT_DECLARATION_E2E=PASS");
  }, 15000);
});
