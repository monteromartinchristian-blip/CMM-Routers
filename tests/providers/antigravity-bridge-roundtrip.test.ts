import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  AntigravityAdapter,
  feedStreamLine,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

function request(requestId: string, messages: RouterRequest["messages"]): RouterRequest {
  return {
    requestId,
    model: {
      id: "google/test-model",
      provider: "google",
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

describe("Antigravity adapter: Qoder-owned tool round-trip through the MCP bridge", () => {
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

  it("registers the CMM-owned MCP server, surfaces the call, and continues the SAME run", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const registrations: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> = [];
    const inferenceArgs: string[][] = [];
    let mcpResponseText: string | undefined;
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    // Fake agy: emits stream-json frames AND acts as the MCP client that agy
    // would be, driving the registered launcher exactly as agy does.
    const runner = {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference(
        args: string[],
        _options: { cwd: string; timeoutMs: number; signal: AbortSignal },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        inferenceArgs.push(args);
        feedStreamLine(JSON.stringify({ step_update: { text_delta: "thinking " } }), onEvent);

        const child = spawn(TSX, [LAUNCHER_TS], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        const seen: string[] = [];
        child.stdout!.setEncoding("utf-8");
        child.stdout!.on("data", (chunk: string) => seen.push(chunk));
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
        child.stdin!.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "cmm_echo", arguments: { text: "canary" } },
          })}\n`,
        );
        // The MCP handler blocks until Qoder's result arrives over the
        // Router control channel; only then does agy continue.
        await waitFor(() => seen.join("").includes('"id":5'));
        const response = JSON.parse(
          seen.join("").split("\n").find((line) => line.includes('"id":5'))!,
        ) as { result: { content: Array<{ text: string }> } };
        mcpResponseText = response.result.content[0]!.text;
        releaseCompletion?.();
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };

    const adapter = new AntigravityAdapter(runner as never, undefined, {
      broker,
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: (name, command, args, env) => registrations.push({ name, command, args, env }),
    });

    // ---- First exchange ----
    const firstEvents = collect(adapter.run(request("agy-1", [{ role: "user", content: "echo" }]), new AbortController().signal));

    await waitFor(() => registrations.length === 1);
    expect(registrations[0]!.name).toBe("cmm-qoder-tools");
    expect(registrations[0]!.command).toBe(TSX);
    expect(registrations[0]!.args[0]).toBe(LAUNCHER_TS);
    // The persistent registration must carry no per-session secret.
    expect(registrations[0]!.env).toEqual({});
    console.log("ANTIGRAVITY_ADAPTER_MCP_WIRING=PASS");

    const first = await firstEvents;
    const delta = first.find((e) => e.type === "tool_call_delta") as
      | { id: string; name: string; argumentsDelta: string }
      | undefined;
    expect(delta).toBeDefined();
    expect(delta!.id.startsWith("cmm_google_")).toBe(true);
    expect(delta!.name).toBe("cmm_echo");
    expect(delta!.argumentsDelta).toBe('{"text":"canary"}');
    expect(first.find((e) => e.type === "completed")).toMatchObject({ finishReason: "tool_calls" });
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("ANTIGRAVITY_MCP_TOOL_REQUEST_RECEIVED=PASS");
    console.log("ANTIGRAVITY_QODER_TOOL_CALL_SURFACED=PASS");

    // Never uses the forbidden permission bypass or native mutation tools.
    expect(inferenceArgs[0]).not.toContain("--dangerously-skip-permissions");
    console.log("ANTIGRAVITY_NATIVE_SHELL_EXECUTION=NONE");

    // ---- Follow-up exchange: Qoder's result continues the SAME agy run ----
    const followPromise = collect(
      adapter.run(
        request("agy-2", [
          { role: "user", content: "echo" },
          { role: "tool", content: "canary-from-qoder", toolCallId: delta!.id },
        ]),
        new AbortController().signal,
      ),
    );
    await waitFor(() => mcpResponseText !== undefined);
    expect(mcpResponseText).toBe("canary-from-qoder");
    console.log("ANTIGRAVITY_QODER_RESULT_CORRELATED=PASS");

    // The SAME run continues and produces its final output.
    await completionGate;
    const follow = await followPromise;
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("ANTIGRAVITY_SAME_RUN_CONTINUATION=PASS");
    expect(follow.find((e) => e.type === "completed" || e.type === "error")).toBeDefined();
  }, 40000);

  it("fails closed on an unmatched tool result without spawning agy", async () => {
    let spawned = false;
    const runner = {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference() {
        spawned = true;
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const adapter = new AntigravityAdapter(runner as never, undefined, {
      broker: new DeferredToolBroker(),
      mcpRegistrar: () => undefined,
    });
    const events = await collect(
      adapter.run(
        request("agy-x", [
          { role: "user", content: "echo" },
          { role: "tool", content: "guessed", toolCallId: "cmm_google_guessed" },
        ]),
        new AbortController().signal,
      ),
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(spawned).toBe(false);
    console.log("ANTIGRAVITY_UNMATCHED_TOOL_RESULT_FAIL_CLOSED=PASS");
  }, 15000);
});
