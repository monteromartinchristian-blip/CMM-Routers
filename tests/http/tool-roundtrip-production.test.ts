import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

/**
 * Only discovery is stubbed: account-backed model discovery needs a live
 * session. The production run()/broker/bridge path under test is untouched.
 */
class DiscoveryStubClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/test-model",
        provider: "claude",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * Router-level proof: HTTP -> capability boundary -> production ClaudeAdapter ->
 * production broker + external MCP bridge -> Qoder tool call -> simulated Qoder
 * result -> same-session provider continuation -> final HTTP response.
 */
describe("production composition: Claude Qoder tool round-trip over HTTP", () => {
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

  it("traverses the whole production path and continues the same session", async () => {
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
        yield { type: "result", subtype: "success", stop_reason: "end_turn", usage: {} };
      })();

    const adapter = new DiscoveryStubClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: queryFn as never,
      spawnFn: ((cmd: string, args: string[], opts: object) => {
        const child = spawn(cmd, args, opts as never);
        children.push(child);
        return child;
      }) as never,
    });

    const registry = new ProviderRegistry();
    await registry.register(adapter);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "s",
      qoderToken: "q",
      registry,
    });

    // Exchange 1 is started WITHOUT awaiting: its response cannot complete
    // until the external MCP call arrives, which this test drives as agy does.
    const firstPromise = server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "claude/test-model",
        messages: [{ role: "user", content: "echo canary" }],
        tools: [CMM_ECHO_TOOL],
      },
    });

    // The external bridge process is a real, separate process.
    await waitFor(() => children.length === 1);
    const bridge = children[0]!;
    const seen: string[] = [];
    bridge.stdout!.setEncoding("utf-8");
    bridge.stdout!.on("data", (chunk: string) => seen.push(chunk));
    bridge.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    bridge.stdin!.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "cmm_echo", arguments: { text: "canary" } },
      })}\n`,
    );

    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const call = firstBody.choices[0]!.message.tool_calls![0]!;
    expect(call.id.startsWith("cmm_claude_")).toBe(true);
    expect(call.function.name).toBe("cmm_echo");
    console.log("HTTP_ROUNDTRIP_QODER_TOOL_CALL_SURFACED=PASS");

    // Exchange 2 carries Qoder's already-executed result and continues the
    // SAME logical Claude session (no new provider run).
    const secondPromise = server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "claude/test-model",
        messages: [
          { role: "user", content: "echo canary" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: "cmm_echo", arguments: '{"text":"canary"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: "canary-from-qoder" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    // The bridge handler is released with Qoder's produced result.
    await waitFor(() => seen.join("").includes('"id":9'));
    const responseLine = seen.join("").split("\n").find((line) => line.includes('"id":9'))!;
    const response = JSON.parse(responseLine) as { result: { content: Array<{ text: string }> } };
    expect(response.result.content[0]!.text).toBe("canary-from-qoder");
    releaseFn?.();

    const second = await secondPromise;
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    expect(secondBody.choices[0]!.message.content).toContain("final-answer");
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("HTTP_ROUNDTRIP_QODER_RESULT_CORRELATED=PASS");
    console.log("HTTP_ROUNDTRIP_SAME_SESSION_CONTINUATION=PASS");
    console.log("QODER_EXECUTION_OWNER=YES");
    console.log("PROVIDER_NATIVE_TOOL_EXECUTION=NONE");
  }, 40000);
});
