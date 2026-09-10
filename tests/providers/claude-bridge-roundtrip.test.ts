import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * Fake SDK query. It emits one text delta, then blocks (exactly like the CLI
 * blocking inside the external MCP handler) until the test releases it after
 * the tool result has been correlated.
 */
function makeFakeQuery(): { queryFn: () => AsyncGenerator<unknown>; release: () => void } {
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const queryFn = () =>
    (async function* () {
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "thinking " } },
      };
      await gate;
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "final-answer" } },
      };
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 7 },
      };
    })();
  return { queryFn, release: () => releaseFn?.() };
}

function request(requestId: string, messages: RouterRequest["messages"], tools = [CMM_ECHO_TOOL]): RouterRequest {
  return {
    requestId,
    model: {
      id: "claude/test-model",
      provider: "claude",
      upstreamModel: "test-model",
      displayName: "Test Model",
      capability: "CHAT_AND_TOOLS",
    },
    messages,
    tools,
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

describe("Claude adapter: Qoder-owned tool round-trip through the MCP bridge", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
  });

  it("declares MCP wiring, surfaces the tool to Qoder, and continues the same session", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const fake = makeFakeQuery();
    let capturedOptions: Record<string, unknown> | undefined;

    const adapter = new ClaudeAdapter({
      broker,
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { options: Record<string, unknown> }) => {
        capturedOptions = args.options;
        return fake.queryFn();
      }) as never,
      spawnFn: ((cmd: string, args: string[], opts: object) => {
        const child = spawn(cmd, args, opts as never);
        children.push(child);
        return child;
      }) as never,
    });

    // ---- First exchange: the model turn reaches the external MCP bridge ----
    const firstEvents = collect(adapter.run(request("claude-1", [{ role: "user", content: "echo" }]), new AbortController().signal));

    // MCP wiring is configured on the real SDK options.
    await waitFor(() => capturedOptions !== undefined);
    expect(capturedOptions?.mcpServers).toBeDefined();
    const servers = capturedOptions!.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.cmm_qoder!.type).toBe("stdio");
    expect((capturedOptions!.allowedTools as string[])[0]).toBe("mcp__cmm_qoder__cmm_echo");
    console.log("CLAUDE_ADAPTER_MCP_WIRING=PASS");
    console.log("CLAUDE_TOOL_DECLARATION=PASS");

    // The external bridge process is a separate, real process.
    await waitFor(() => children.length === 1);
    const bridge = children[0]!;
    const seen: string[] = [];
    bridge.stdout?.setEncoding("utf-8");
    bridge.stdout?.on("data", (chunk: string) => seen.push(chunk));
    const send = (msg: object) => bridge.stdin!.write(`${JSON.stringify(msg)}\n`);
    console.log("CLAUDE_EXTERNAL_BRIDGE_PROCESS=PASS");

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "cmm_echo", arguments: { text: "canary" } },
    });

    const first = await firstEvents;
    const delta = first.find((e) => e.type === "tool_call_delta") as
      | { id: string; name: string; argumentsDelta: string }
      | undefined;
    expect(delta).toBeDefined();
    expect(delta!.id.startsWith("cmm_claude_")).toBe(true);
    expect(delta!.name).toBe("cmm_echo");
    expect(delta!.argumentsDelta).toBe('{"text":"canary"}');
    expect(first.find((e) => e.type === "completed")).toMatchObject({ finishReason: "tool_calls" });
    // The MCP call must still be unanswered: nothing executed locally.
    await waitFor(() => seen.join("").includes('"id":1'));
    expect(seen.join("").includes('"id":7')).toBe(false);
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("CLAUDE_QODER_TOOL_CALL_SURFACED=PASS");
    console.log("CLAUDE_NATIVE_TOOL_EXECUTION=NONE");

    // ---- Follow-up exchange: Qoder's result continues the SAME session ----
    const followPromise = collect(
      adapter.run(
        request("claude-2", [
          { role: "user", content: "echo" },
          { role: "tool", content: "canary-from-qoder", toolCallId: delta!.id },
        ]),
        new AbortController().signal,
      ),
    );
    // The bridge handler is released with Qoder's already-produced result.
    await waitFor(() => seen.join("").includes('"id":7'));
    fake.release();
    const follow = await followPromise;

    const response = seen.join("").split("\n").find((line) => line.includes('"id":7'))!;
    const parsed = JSON.parse(response) as { result: { content: Array<{ text: string }> } };
    expect(parsed.result.content[0]!.text).toBe("canary-from-qoder");
    console.log("CLAUDE_QODER_RESULT_CORRELATED=PASS");

    const followText = follow
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(followText).toContain("final-answer");
    expect(follow.find((e) => e.type === "completed")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION=PASS");
  }, 30000);

  it("fails closed on an unmatched tool result without opening a new session", async () => {
    const adapter = new ClaudeAdapter({
      broker: new DeferredToolBroker(),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: (() => {
        throw new Error("query must not be reached for an unmatched tool result");
      }) as never,
    });
    const events = await collect(
      adapter.run(
        request("claude-x", [
          { role: "user", content: "echo" },
          { role: "tool", content: "guessed", toolCallId: "cmm_claude_guessed" },
        ]),
        new AbortController().signal,
      ),
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("CLAUDE_UNMATCHED_TOOL_RESULT_FAIL_CLOSED=PASS");
  }, 15000);
});
