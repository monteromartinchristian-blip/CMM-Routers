import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { createFakeClaudeSdk } from "../helpers/fake-claude-sdk.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

function request(
  requestId: string,
  messages: RouterRequest["messages"],
): RouterRequest {
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

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/** Drain without stopping at the first terminal event (continuation path). */
async function drainAll(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("Claude provider lifecycle", () => {
  it("aborts the live provider run when the parked-session TTL expires", async () => {
    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: "arg" },
    });
    const adapter = new ClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      sessionTtlMs: 250,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
    });

    const first = await collect(
      adapter.run(request("ttl-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
    );
    expect(first.find((e) => e.type === "tool_call_delta")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(1);

    // TTL expiry must terminate the provider run, not merely Router state.
    await waitFor(() => fake.wasAborted(), 5000);
    expect(fake.wasAborted()).toBe(true);
    await waitFor(() => adapter.activeToolSessions() === 0, 5000);
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("CLAUDE_TTL_ABORTS_PROVIDER_RUN=PASS");
    console.log("CLAUDE_TERMINAL_STATE_CLEANUP=PASS");
  }, 60000);

  it("aborts the live provider run when the continuation is cancelled", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: "arg" },
      holdAfterResult: () => hold,
    });
    const adapter = new ClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
    });

    try {
      const first = await collect(
        adapter.run(request("life-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
      );
      const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(delta).toBeDefined();
      expect(fake.wasAborted()).toBe(false);

      // Start the continuation; it resolves the tool result and then the
      // provider holds in RESUMING state.
      const continuation = drainAll(
        adapter.run(
          request("life-2", [
            { role: "user", content: "echo" },
            { role: "tool", content: "RESULT-X", toolCallId: delta!.id },
          ]),
          new AbortController().signal,
        ),
      );
      // Wait until the provider actually consumed the tool result.
      const deadline = Date.now() + 10000;
      while (fake.mcpToolResult() === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fake.mcpToolResult()).toBe("RESULT-X");

      // The continuation HTTP client disconnects -> the exact same provider run
      // must be aborted. Abort is synchronous inside cleanup; iterator release
      // waits for the generator to unwind, so assert before releasing the hold.
      const cancelPromise = adapter.cancel("life-2");
      await waitFor(() => fake.wasAborted(), 5000);
      expect(fake.wasAborted()).toBe(true);
      releaseHold?.();
      await cancelPromise;
      await continuation;
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("CLAUDE_POST_RESULT_CANCEL_ABORTS_PROVIDER_RUN=PASS");
    } finally {
      releaseHold?.();
    }
  }, 60000);
});
