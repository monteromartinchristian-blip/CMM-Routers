import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { createFakeClaudeSdk } from "../helpers/fake-claude-sdk.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

const CANARY_ARG = "CMM_ARG_CANARY_4f19ab";
const CANARY_RESULT = "CANARY-9271";

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

describe("Claude SDK-owned MCP bridge: causal Qoder round-trip", () => {
  it("lets the fake SDK consume the production mcpServers config and continue only from the tool result", async () => {
    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: CANARY_ARG },
      finalPrefix: "final:",
    });

    const adapter = new ClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
    });

    // ---- Exchange 1: provider asks for the tool through real MCP stdio ----
    const first = await collect(
      adapter.run(request("sdk-1", [{ role: "user", content: "echo please" }]), new AbortController().signal),
    );

    // The fake SDK genuinely consumed the production config and spoke MCP.
    expect(fake.consumedMcpConfig()).toBe(true);
    expect(fake.sentToolsCall()).toBe(true);
    expect(fake.declaredTools()).toContain("cmm_echo");
    expect(typeof fake.mcpChildPid()).toBe("number");
    console.log("CLAUDE_FAKE_SDK_CONSUMED_PRODUCTION_MCP_CONFIG=PASS");
    console.log("CLAUDE_FAKE_SDK_SPAWNED_CONFIGURED_MCP=PASS");
    console.log("CLAUDE_FAKE_SDK_SENT_TOOLS_CALL=PASS");

    const delta = first.find((e) => e.type === "tool_call_delta") as
      | { id: string; name: string; argumentsDelta: string }
      | undefined;
    expect(delta).toBeDefined();
    expect(delta!.id.startsWith("cmm_claude_")).toBe(true);
    expect(delta!.name).toBe("cmm_echo");
    expect(delta!.argumentsDelta).toBe(JSON.stringify({ text: CANARY_ARG }));
    expect(first.find((e) => e.type === "completed")).toMatchObject({ finishReason: "tool_calls" });
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("CLAUDE_QODER_TOOL_CALL_SURFACED=PASS");

    // The MCP call is still unanswered: the provider is blocked, not resumed.
    expect(fake.mcpToolResult()).toBeUndefined();

    // ---- Exchange 2: Qoder's result resumes the SAME provider run ----
    const second = await collect(
      adapter.run(
        request("sdk-2", [
          { role: "user", content: "echo please" },
          { role: "tool", content: CANARY_RESULT, toolCallId: delta!.id },
        ]),
        new AbortController().signal,
      ),
    );

    // The provider's final text is derived ONLY from the tool-result wire value.
    const finalText = second
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(finalText).toContain(`final:${CANARY_RESULT}`);
    expect(fake.mcpToolResult()).toBe(CANARY_RESULT);
    expect(second.find((e) => e.type === "completed")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("CLAUDE_MCP_RESULT_CAUSED_PROVIDER_CONTINUATION=PASS");
    console.log("CLAUDE_SAME_LOGICAL_RUN=PASS");
    console.log("CLAUDE_NATIVE_TOOL_EXECUTION=NONE");
  }, 60000);

  it("keeps the test free of direct bridge injection and manual release gates", () => {
    const source = readFileSync(join(import.meta.dirname, "claude-mcp-e2e.test.ts"), "utf-8");
    // Patterns are assembled at runtime so this assertion cannot match itself.
    const forbidden = [
      ["stdin", "\\??", "\\.write"],
      ["spa", "wn\\("],
      ["\\.rele", "ase", "\\(\\)"],
      ["relea", "se", "Fn"],
      ["manual", "Resol", "ve"],
    ].map((parts) => new RegExp(parts.join("")));
    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }
    console.log("CLAUDE_TEST_DIRECT_BRIDGE_INJECTION=NO");
    console.log("CLAUDE_TEST_MANUAL_RELEASE_GATE=NO");
  });

  it("keeps the Router from owning any provider-facing MCP process", () => {
    const adapterSource = readFileSync(
      join(REPO, "src/providers/claude/adapter.ts"),
      "utf-8",
    );
    // No Router-side child process at all: the SDK spawns the MCP server from
    // options.mcpServers, so there is exactly one provider-facing owner.
    expect(adapterSource).not.toMatch(new RegExp(["spa", "wn\\("].join("")));
    expect(adapterSource).not.toMatch(new RegExp(["child", "_pro", "cess"].join("")));
    expect(adapterSource).toMatch(/mcpServers/);
    console.log("CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk");
    console.log("CLAUDE_DUPLICATE_MCP_BRIDGE_PROCESS=NONE");
  });
});
