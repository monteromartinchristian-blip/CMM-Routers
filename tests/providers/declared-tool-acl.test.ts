import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import { BridgeControlServer } from "../../src/bridge/control-ipc.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

const ADVERSARIAL = ["run_command", "write_file", "apply_patch", "totally_unknown_tool"];

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

// ---------------------------------------------------------------- MCP bridge

describe("declared-tool ACL: MCP bridge", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  });

  it("refuses an undeclared tool name without surfacing it to the Router", async () => {
    const forwarded: string[] = [];
    const control = await BridgeControlServer.listen({
      onToolCall: (request) => forwarded.push(request.name),
    });
    const child = spawn(TSX, [BRIDGE_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CMM_BRIDGE_SOCKET: control.socketPath,
        CMM_BRIDGE_TOKEN: control.token,
        CMM_BRIDGE_TOOLS: JSON.stringify([
          { name: "cmm_echo", inputSchema: { type: "object" } },
        ]),
      },
    });
    children.push(child);
    const seen: string[] = [];
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => seen.push(chunk));
    const send = (msg: object) => child.stdin!.write(`${JSON.stringify(msg)}\n`);

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await waitFor(() => seen.join("").includes('"id":1'));
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await waitFor(() => seen.join("").includes('"id":2'));
      const listed = JSON.parse(
        seen.join("").split("\n").find((l) => l.includes('"id":2'))!,
      ) as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map((t) => t.name)).toEqual(["cmm_echo"]);

      for (const [offset, name] of ADVERSARIAL.entries()) {
        const id = 100 + offset;
        send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
        await waitFor(() => seen.join("").split("\n").some((l) => l.includes(`"id":${id}`)));
        const line = seen.join("").split("\n").find((l) => l.includes(`"id":${id}`))!;
        const parsed = JSON.parse(line) as { error?: { code: number } };
        expect(parsed.error).toBeDefined();
        expect(parsed.error!.code).toBe(-32602);
      }

      // Nothing undeclared ever reached the Router, and no pending call remains.
      expect(forwarded).toEqual([]);
      expect(control.pendingCount()).toBe(0);
      console.log("MCP_UNDECLARED_TOOL_CALL_FAIL_CLOSED=PASS");
    } finally {
      await control.close().catch(() => undefined);
    }
  }, 30000);
});

// -------------------------------------------------------------------- Codex

interface SeenMessage {
  method: string;
  params: Record<string, unknown>;
  id?: unknown;
}

function scriptedCodex(toolName: string): {
  adapter: CodexAdapter;
  toolResponses: Array<{ id: unknown; result: Record<string, unknown> }>;
} {
  const toolResponses: Array<{ id: unknown; result: Record<string, unknown> }> = [];
  const duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as SeenMessage;
      const push = (message: object): void => {
        duplex.push(`${JSON.stringify(message)}\n`);
      };
      if (msg.method === "initialize") {
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
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
              callId: "call_codex_adv",
              namespace: null,
              threadId: "thread-1",
              turnId: "turn-1",
              tool: toolName,
            },
          });
        }, 20);
      } else if (
        (msg as unknown as { result?: unknown }).result !== undefined &&
        msg.id === 901
      ) {
        toolResponses.push({
          id: msg.id,
          result: (msg as unknown as { result: Record<string, unknown> }).result,
        });
      }
      callback();
    },
  });
  const adapter = new CodexAdapter();
  const client = new CodexAppServerClient(duplex);
  (adapter as unknown as { client: unknown }).client = client;
  return { adapter, toolResponses };
}

describe("declared-tool ACL: Codex dynamic tools", () => {
  it("fails closed when item/tool/call names an undeclared dynamic tool", async () => {
    const { adapter, toolResponses } = scriptedCodex("run_command");
    const request: RouterRequest = {
      requestId: "codex-adv",
      model: {
        id: "chatgpt/gpt-5",
        provider: "chatgpt",
        upstreamModel: "gpt-5",
        displayName: "GPT-5",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "do it" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
    };
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal)) {
      events.push(event);
      if (event.type === "completed" || event.type === "error") break;
    }
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    // No Qoder-facing tool call was surfaced.
    expect(events.find((e) => e.type === "tool_call_delta")).toBeUndefined();
    // The original wire request was answered so the provider turn terminates.
    expect(toolResponses.length).toBe(1);
    expect(toolResponses[0]!.result.success).toBe(false);
    console.log("CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS");
  }, 30000);
});

// ------------------------------------------------------------- Command Code

function sse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

describe("declared-tool ACL: Command Code wires", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-acl-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function adapterFor(frames: Array<Record<string, unknown>>): CommandCodeAdapter {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async () => ({ status: 200, text: async () => sse(frames) })) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  async function drain(adapter: CommandCodeAdapter, request: RouterRequest): Promise<RouterEvent[]> {
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal)) {
      events.push(event);
      if (event.type === "completed" || event.type === "error") break;
    }
    return events;
  }

  it("fails closed on an undeclared tool name on the OpenAI wire", async () => {
    const adapter = adapterFor([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_adv",
                  type: "function",
                  function: { name: "run_command", arguments: '{"cmd":"rm -rf /"}' },
                },
              ],
            },
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ],
      },
    ]);
    const events = await drain(adapter, {
      requestId: "cc-openai-adv",
      model: {
        id: "command-code/gpt-5",
        provider: "command-code",
        upstreamModel: "gpt-5",
        displayName: "gpt-5",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "do it" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(events.find((e) => e.type === "tool_call_delta")).toBeUndefined();
    console.log("COMMAND_CODE_OPENAI_UNDECLARED_TOOL_FAIL_CLOSED=PASS");
  }, 30000);

  it("fails closed on an undeclared tool name on the Anthropic wire", async () => {
    const adapter = adapterFor([
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_adv", name: "totally_unknown_tool" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    const events = await drain(adapter, {
      requestId: "cc-anthropic-adv",
      model: {
        id: "command-code/claude-sonnet-4-5",
        provider: "command-code",
        upstreamModel: "claude-sonnet-4-5",
        displayName: "claude-sonnet-4-5",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "do it" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(events.find((e) => e.type === "tool_call_delta")).toBeUndefined();
    console.log("COMMAND_CODE_ANTHROPIC_UNDECLARED_TOOL_FAIL_CLOSED=PASS");
  }, 30000);
});
