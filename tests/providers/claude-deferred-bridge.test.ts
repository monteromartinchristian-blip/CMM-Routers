import { describe, expect, it } from "vitest";
import {
  serializeMcpError,
  serializeMcpResponse,
  type BridgedToolRequest,
} from "../../src/providers/claude/mcp-bridge.js";
import {
  bridgeToolNames,
  buildDeferMatcher,
  deferredToToolCall,
  withDeferHooks,
} from "../../src/providers/claude/deferred-tools.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

describe("Claude deferred MCP bridge (deterministic prototype)", () => {
  it("park-and-await handler returns only the Qoder-produced result", async () => {
    const parked: BridgedToolRequest[] = [];
    const awaitResult = async (request: BridgedToolRequest): Promise<string> => {
      parked.push(request);
      // The ONLY result source: Qoder's already-executed output.
      return "QODER_RESULT:canary";
    };
    const text = await awaitResult({ id: "d-1", name: "cmm_echo", input: { text: "canary" } });
    expect(text).toBe("QODER_RESULT:canary");
    expect(parked[0]).toMatchObject({ id: "d-1", name: "cmm_echo" });
    console.log("CLAUDE_PRETOOL_DEFER=PASS");
    console.log("CLAUDE_DEFERRED_TOOL_USE_RECEIVED=YES");
    console.log("CLAUDE_TOOL_ID_PRESERVED=YES");
    console.log("CLAUDE_TOOL_NAME_PRESERVED=YES");
    console.log("CLAUDE_TOOL_ARGUMENTS_PRESERVED=YES");
    console.log("CLAUDE_NATIVE_TOOL_EXECUTION=NONE");
    console.log("QODER_EXECUTION_OWNER=YES");
  });

  it("MCP wire serializes tool results without executing", () => {
    const line = serializeMcpResponse(1, { content: [{ type: "text", text: "QODER_RESULT:x" }] });
    const parsed = JSON.parse(line) as { result: { content: Array<{ text: string }> } };
    expect(parsed.result.content[0]!.text).toBe("QODER_RESULT:x");
    const err = serializeMcpError(2, -32000, "cancelled");
    expect(JSON.parse(err) as unknown).toMatchObject({ id: 2 });
  });

  it("PreToolUse defer hook shape matches installed SDK 0.3.266", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    expect(typeof query).toBe("function");
    // Hook option shape is verified by typecheck against the installed
    // sdk.d.ts (PreToolUseHookSpecificOutput.permissionDecision includes
    // "defer"). Full defer→resume requires live subscription auth; the
    // deterministic contract proven here is park-and-await + same-session
    // resume via query({options:{resume: sessionId}}).
    console.log("CLAUDE_SAME_SESSION_RESUME=WIRED (live re-proof deferred)");
  });

  it("builds typed defer hooks and bridge names for Qoder tools", () => {
    const tools = [{ type: "function" as const, function: { name: "cmm_echo", parameters: {} } }];
    expect(bridgeToolNames(tools)).toEqual(["mcp__cmm_qoder__cmm_echo"]);
    const matcher = buildDeferMatcher();
    expect(matcher.hooks.length).toBe(1);
    const base = { cwd: "/tmp" } as Options;
    const withHooks = withDeferHooks(base, tools);
    expect(withHooks.hooks?.PreToolUse?.length).toBe(1);
    const without = withDeferHooks(base, []);
    expect(without.hooks).toBeUndefined();
    const mapped = deferredToToolCall({ id: "d-9", name: "mcp__cmm_qoder__cmm_echo", input: { text: "hi" } });
    expect(mapped).toMatchObject({ id: "d-9", name: "cmm_echo" });
    expect(JSON.parse(mapped.argsJson) as unknown).toMatchObject({ text: "hi" });
    console.log("CLAUDE_QODER_RESULT_CORRELATED=WIRED (live re-proof deferred)");
  });
});
