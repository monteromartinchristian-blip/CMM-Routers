import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { createFakeClaudeSdkMultiStep } from "../helpers/fake-claude-sdk-multistep.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

/** Only discovery is stubbed: it needs a live account session. */
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

interface ChatBody {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

function toolCallOf(body: ChatBody): { id: string; name: string; arguments: string } {
  const call = body.choices[0]!.message.tool_calls?.[0];
  expect(call, `expected a tool call, got ${JSON.stringify(body)}`).toBeDefined();
  return { id: call!.id, name: call!.function.name, arguments: call!.function.arguments };
}

/**
 * Router-level proof of the MULTI-STEP Qoder agent loop over the real OpenAI
 * HTTP surface:
 *
 *   POST /v1/chat/completions            -> tool_call A
 *   POST ... + tool result A             -> tool_call B  (SAME logical run)
 *   POST ... + tool result B             -> final answer derived from A AND B
 *
 * The provider is the protocol-faithful multi-step fake SDK: it consumes the
 * production `options.mcpServers` config, speaks real MCP stdio, and issues
 * tool B ONLY after result A arrived through the production transport. The test
 * never touches the MCP wire and never releases a manual final answer.
 */
describe("production composition: Claude multi-step Qoder agent loop over HTTP", () => {
  it("completes two sequential tool round-trips in one logical run", async () => {
    const ARG_A_SENTINEL = "CMM_MS_ARG_A_11a4";
    const CANARY_A = "CMM_MS_RESULT_A_7f3a91";
    const CANARY_B = "CMM_MS_RESULT_B_2d70c4";
    const RESULT_A = `RESULT_A=${CANARY_A}`;
    const RESULT_B = `RESULT_B=${CANARY_B}`;

    const fake = createFakeClaudeSdkMultiStep({
      toolA: { name: "cmm_echo", arguments: { text: ARG_A_SENTINEL } },
      toolBName: "cmm_echo",
      // Step B is only reachable after result A, and embeds it.
      toolBArguments: (resultA) => ({ text: `B_FROM_A:${resultA}` }),
      finalPrefix: "final:",
    });

    const adapter = new DiscoveryStubClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
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

    const tools = [CMM_ECHO_TOOL];
    const userTurn = { role: "user", content: "two-step agent loop" };

    // ---- Exchange 1: provider asks Qoder for TOOL_A ----
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: { model: "claude/test-model", messages: [userTurn], tools },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ChatBody;
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const callA = toolCallOf(firstBody);
    expect(callA.id.startsWith("cmm_claude_")).toBe(true);
    expect(callA.name).toBe("cmm_echo");
    expect(JSON.parse(callA.arguments) as unknown).toEqual({ text: ARG_A_SENTINEL });
    expect(fake.consumedMcpConfig()).toBe(true);
    expect(fake.toolCallCount()).toBe(1);
    // The provider-facing MCP call is still unanswered: nothing ran locally.
    expect(fake.resultA()).toBeUndefined();
    console.log("MULTI_STEP_HTTP_TOOL_A_CALL_SURFACED=PASS");

    // ---- Exchange 2: Qoder posts result A -> provider asks for TOOL_B ----
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "claude/test-model",
        messages: [
          userTurn,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: callA.arguments } },
            ],
          },
          { role: "tool", tool_call_id: callA.id, content: RESULT_A },
        ],
        tools,
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ChatBody;
    expect(secondBody.choices[0]!.finish_reason).toBe("tool_calls");
    const callB = toolCallOf(secondBody);
    expect(callB.id.startsWith("cmm_claude_")).toBe(true);
    expect(callB.id).not.toBe(callA.id);
    // Tool B's arguments embed result A: only the provider could know it.
    expect(callB.arguments).toContain(`B_FROM_A:${RESULT_A}`);
    expect(fake.resultA()).toBe(RESULT_A);
    expect(fake.toolCallCount()).toBe(2);
    const stages = fake.stages();
    expect(stages.indexOf("result-a-received")).toBeLessThan(stages.indexOf("tool-b-sent"));
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("MULTI_STEP_HTTP_TOOL_B_CALL_SURFACED=PASS");
    console.log("MULTI_STEP_HTTP_TOOL_B_CAUSED_BY_WIRE_RESULT_A=PASS");

    // ---- Exchange 3: Qoder posts result B -> final answer from BOTH ----
    const third = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "claude/test-model",
        messages: [
          userTurn,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: callA.arguments } },
            ],
          },
          { role: "tool", tool_call_id: callA.id, content: RESULT_A },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: callB.id, type: "function", function: { name: "cmm_echo", arguments: callB.arguments } },
            ],
          },
          { role: "tool", tool_call_id: callB.id, content: RESULT_B },
        ],
        tools,
      },
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json() as ChatBody;
    expect(thirdBody.choices[0]!.finish_reason).toBe("stop");
    const content = thirdBody.choices[0]!.message.content ?? "";
    expect(content).toContain(`RESULT_A=${CANARY_A}`);
    expect(content).toContain(`RESULT_B=${CANARY_B}`);
    expect(fake.resultB()).toBe(RESULT_B);
    expect(fake.finalText()).toBe(`final:A=${RESULT_A}|B=${RESULT_B}`);
    expect(adapter.activeToolSessions()).toBe(0);
    console.log("MULTI_STEP_QODER_AGENT_LOOP_CLAUDE=PASS");
    console.log("MULTI_STEP_FINAL_ANSWER_DERIVED_FROM_TWO_RESULTS=PASS");
    console.log("MULTI_STEP_ONE_LOGICAL_CLAUDE_RUN=PASS");
  }, 60000);
});
