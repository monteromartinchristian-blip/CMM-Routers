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

const RESULT_CANARY = "BRIDGE-CANARY-5521";

function request(
  requestId: string,
  messages: RouterRequest["messages"],
  tools = [CMM_ECHO_TOOL],
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
  it("declares MCP wiring, surfaces the tool to Qoder, and continues the same session", async () => {
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: "canary" },
      finalPrefix: "answer=",
    });

    const adapter = new ClaudeAdapter({
      broker,
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
    });

    const first = await collect(
      adapter.run(request("claude-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
    );

    // Production declared exactly one provider-facing MCP server, and the
    // protocol-faithful SDK consumed it and spoke real MCP stdio.
    expect(fake.consumedMcpConfig()).toBe(true);
    expect(fake.declaredTools()).toEqual(["cmm_echo"]);
    expect(fake.sentToolsCall()).toBe(true);
    console.log("CLAUDE_ADAPTER_MCP_WIRING=PASS");
    console.log("CLAUDE_TOOL_DECLARATION=PASS");

    const delta = first.find((e) => e.type === "tool_call_delta") as
      | { id: string; name: string; argumentsDelta: string }
      | undefined;
    expect(delta).toBeDefined();
    expect(delta!.id.startsWith("cmm_claude_")).toBe(true);
    expect(delta!.name).toBe("cmm_echo");
    expect(delta!.argumentsDelta).toBe('{"text":"canary"}');
    expect(first.find((e) => e.type === "completed")).toMatchObject({ finishReason: "tool_calls" });
    // The MCP call must still be unanswered: nothing executed locally.
    expect(fake.mcpToolResult()).toBeUndefined();
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("CLAUDE_QODER_TOOL_CALL_SURFACED=PASS");
    console.log("CLAUDE_NATIVE_TOOL_EXECUTION=NONE");

    // ---- Follow-up exchange: Qoder's result continues the SAME session ----
    const follow = await collect(
      adapter.run(
        request("claude-2", [
          { role: "user", content: "echo" },
          { role: "tool", content: RESULT_CANARY, toolCallId: delta!.id },
        ]),
        new AbortController().signal,
      ),
    );

    expect(fake.mcpToolResult()).toBe(RESULT_CANARY);
    console.log("CLAUDE_QODER_RESULT_CORRELATED=PASS");

    const followText = follow
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(followText).toContain(`answer=${RESULT_CANARY}`);
    expect(follow.find((e) => e.type === "completed")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION=PASS");
  }, 60000);

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
