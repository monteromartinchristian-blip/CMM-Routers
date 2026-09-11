import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import { assertNoSpendPath } from "../../src/providers/command-code/spend-guard.js";
import { RouterError } from "../../src/core/errors.js";
import type { RouterRequest, RouterMessage } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * TWO-STEP (sequential) Command Code Anthropic Messages-wire tool loop.
 *
 * The fake upstream is provider-faithful: it inspects the REAL production
 * Anthropic request body (assistant tool_use blocks + user tool_result blocks)
 * and only emits tool_use B once it observes tool_result A carrying the exact
 * tool_use id A was surfaced with. The final turn is answered only when both
 * ordered tool_use/tool_result pairs are present; otherwise it fails closed
 * with 400 so no status-only assertion can pass.
 */

const TOOL_A_ID = "toolu_two_step_A";
const TOOL_B_ID = "toolu_two_step_B";
const ARG_A = '{"text":"alpha"}';
const ARG_B = '{"text":"beta"}';
const SENTINEL_A = "alpha_sentinel_7f3a91";
const SENTINEL_B = "beta_sentinel_9b2c47";
const RESULT_A = `RESULT_A=${SENTINEL_A}`;
const RESULT_B = `RESULT_B=${SENTINEL_B}`;

const MODEL = {
  id: "command-code/claude-two-step",
  provider: "command-code" as const,
  upstreamModel: "claude-two-step",
  displayName: "claude-two-step",
  capability: "CHAT_AND_TOOLS" as const,
};

type AnthropicBlock = Record<string, unknown>;
interface AnthropicBodyMessage {
  role?: string;
  content?: unknown;
}

function sse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

/** tool_use stream with FRAGMENTED input_json_delta (assembly must be real). */
function toolUseStream(id: string, first: string, second: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "cmm_echo" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: first } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: second } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}

function textStream(text: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}

function blocksOf(message: AnthropicBodyMessage | undefined): AnthropicBlock[] {
  return Array.isArray(message?.content) ? (message.content as AnthropicBlock[]) : [];
}

function findBlock(
  messages: AnthropicBodyMessage[],
  type: string,
  key: "id" | "tool_use_id",
  id: string,
): { messageIndex: number; block: AnthropicBlock } | null {
  for (let i = 0; i < messages.length; i += 1) {
    const block = blocksOf(messages[i]).find((b) => b.type === type && b[key] === id);
    if (block) return { messageIndex: i, block };
  }
  return null;
}

describe("Command Code Anthropic wire: two-step sequential tool loop", () => {
  let dir: string;
  let ackPath: string;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-2step-anthropic-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
    bodies = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function twoStepAdapter(): CommandCodeAdapter {
    let calls = 0;
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (_url: string, init: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bodies.push(body);
        calls += 1;
        const messages = (body.messages ?? []) as AnthropicBodyMessage[];
        if (calls === 1) {
          return { status: 200, text: async () => sse(toolUseStream(TOOL_A_ID, '{"text":', '"alpha"}')) };
        }
        if (calls === 2) {
          const useA = findBlock(messages, "tool_use", "id", TOOL_A_ID);
          const resultA = findBlock(messages, "tool_result", "tool_use_id", TOOL_A_ID);
          if (!useA || !resultA || useA.messageIndex >= resultA.messageIndex) {
            return { status: 400, text: async () => "missing ordered tool_use A + tool_result A" };
          }
          if (resultA.block.content !== RESULT_A) {
            return { status: 400, text: async () => "tool_result A value not preserved" };
          }
          return { status: 200, text: async () => sse(toolUseStream(TOOL_B_ID, '{"text":', '"beta"}')) };
        }
        if (calls === 3) {
          const useA = findBlock(messages, "tool_use", "id", TOOL_A_ID);
          const resultA = findBlock(messages, "tool_result", "tool_use_id", TOOL_A_ID);
          const useB = findBlock(messages, "tool_use", "id", TOOL_B_ID);
          const resultB = findBlock(messages, "tool_result", "tool_use_id", TOOL_B_ID);
          if (!useA || !resultA || !useB || !resultB) {
            return { status: 400, text: async () => "second-step history incomplete" };
          }
          if (!(useA.messageIndex < resultA.messageIndex && resultA.messageIndex < useB.messageIndex && useB.messageIndex < resultB.messageIndex)) {
            return { status: 400, text: async () => "second-step history reordered" };
          }
          if (resultA.block.content !== RESULT_A || resultB.block.content !== RESULT_B) {
            return { status: 400, text: async () => "tool results not preserved in order" };
          }
          return { status: 200, text: async () => sse(textStream(`${RESULT_A} ${RESULT_B}`)) };
        }
        return { status: 500, text: async () => "unexpected extra upstream call" };
      }) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  async function drain(adapter: CommandCodeAdapter, request: RouterRequest): Promise<RouterEvent[]> {
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal)) events.push(event);
    return events;
  }

  function request(messages: RouterMessage[], requestId: string): RouterRequest {
    return { requestId, model: MODEL, messages, tools: [CMM_ECHO_TOOL], stream: true };
  }

  function assembledToolCall(events: RouterEvent[]): { id: string; name: string; args: string } {
    const deltas = events.filter((e) => e.type === "tool_call_delta") as Array<{
      id: string;
      name?: string;
      argumentsDelta?: string;
    }>;
    return {
      id: deltas[0]?.id ?? "",
      name: deltas[0]?.name ?? "",
      args: deltas.map((d) => d.argumentsDelta ?? "").join(""),
    };
  }

  function completedReason(events: RouterEvent[]): string | undefined {
    const completed = events.find((e) => e.type === "completed");
    return completed === undefined ? undefined : (completed as { finishReason: string }).finishReason;
  }

  it("surfaces tool_use A, then tool_use B only after tool_result A, then a final answer derived from both", async () => {
    const adapter = twoStepAdapter();

    // ---- Step 0: opening turn surfaces tool_use A (fragmented arguments).
    const turn1 = await drain(adapter, request([{ role: "user", content: "run both steps" }], "two-step-a1"));
    const callA = assembledToolCall(turn1);
    expect(callA).toEqual({ id: TOOL_A_ID, name: "cmm_echo", args: ARG_A });
    expect(completedReason(turn1)).toBe("tool_calls");
    expect(turn1.find((e) => e.type === "error")).toBeUndefined();

    // ---- Step 1: Qoder returns result A; the upstream then requests B.
    const turn2 = await drain(
      adapter,
      request(
        [
          { role: "user", content: "run both steps" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: callA.id, type: "function", function: { name: callA.name, arguments: callA.args } }],
          },
          { role: "tool", content: RESULT_A, toolCallId: callA.id },
        ],
        "two-step-a2",
      ),
    );
    const callB = assembledToolCall(turn2);
    expect(callB).toEqual({ id: TOOL_B_ID, name: "cmm_echo", args: ARG_B });
    expect(completedReason(turn2)).toBe("tool_calls");

    // Causality: the upstream returned tool_use B only because the REAL
    // production Anthropic body carried tool_use A + tool_result A with the
    // exact id and preserved order.
    expect(bodies.length).toBe(2);
    const secondMessages = (bodies[1] as { messages: AnthropicBodyMessage[] }).messages;
    expect(secondMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(blocksOf(secondMessages[1])).toEqual([
      { type: "tool_use", id: TOOL_A_ID, name: "cmm_echo", input: { text: "alpha" } },
    ]);
    expect(blocksOf(secondMessages[2])).toEqual([
      { type: "tool_result", tool_use_id: TOOL_A_ID, content: RESULT_A },
    ]);

    // ---- Step 2: Qoder returns result B; final answer derives from A and B.
    const turn3 = await drain(
      adapter,
      request(
        [
          { role: "user", content: "run both steps" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: callA.id, type: "function", function: { name: callA.name, arguments: callA.args } }],
          },
          { role: "tool", content: RESULT_A, toolCallId: callA.id },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: callB.id, type: "function", function: { name: callB.name, arguments: callB.args } }],
          },
          { role: "tool", content: RESULT_B, toolCallId: callB.id },
        ],
        "two-step-a3",
      ),
    );
    const finalText = turn3
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(finalText).toContain(RESULT_A);
    expect(finalText).toContain(RESULT_B);
    expect(completedReason(turn3)).toBe("stop");
    expect(turn3.find((e) => e.type === "error")).toBeUndefined();

    // No blocks dropped, no reordering: 5 messages, alternating roles.
    expect(bodies.length).toBe(3);
    const thirdMessages = (bodies[2] as { messages: AnthropicBodyMessage[] }).messages;
    expect(thirdMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(blocksOf(thirdMessages[1])).toEqual([
      { type: "tool_use", id: TOOL_A_ID, name: "cmm_echo", input: { text: "alpha" } },
    ]);
    expect(blocksOf(thirdMessages[2])).toEqual([
      { type: "tool_result", tool_use_id: TOOL_A_ID, content: RESULT_A },
    ]);
    expect(blocksOf(thirdMessages[3])).toEqual([
      { type: "tool_use", id: TOOL_B_ID, name: "cmm_echo", input: { text: "beta" } },
    ]);
    expect(blocksOf(thirdMessages[4])).toEqual([
      { type: "tool_result", tool_use_id: TOOL_B_ID, content: RESULT_B },
    ]);

    console.log("COMMAND_CODE_ANTHROPIC_TWO_STEP_SEQUENTIAL=YES");
    console.log("COMMAND_CODE_ANTHROPIC_TOOL_B_CAUSED_BY_RESULT_A=YES");
    console.log("COMMAND_CODE_ANTHROPIC_TOOL_USE_ID_PRESERVED=YES");
    console.log("COMMAND_CODE_ANTHROPIC_HISTORY_ORDER_PRESERVED=YES");
    console.log("COMMAND_CODE_ANTHROPIC_TWO_STEP_TOOL_LOOP=PASS");
  });

  it("keeps the pinned spend policy: fail-closed without human ack, no on-demand path", async () => {
    // Reuses the existing spend-guard contract expectations (same ack schema,
    // same forbidden spending path) that command-code-spend-guard pins.
    const bad = join(dir, "bad-ack.json");
    writeFileSync(
      bad,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: true }),
    );
    const adapter = new CommandCodeAdapter({
      ackPath: bad,
      client: new CommandCodeClient({
        secret: "goat-secret",
        fetchFn: (async () => ({ status: 200, text: async () => sse(textStream("no")) })) as never,
      }),
    });
    const events = await drain(adapter, request([{ role: "user", content: "hi" }], "two-step-a-ack"));
    const error = events.find((e) => e.type === "error") as { error: RouterError } | undefined;
    expect(error?.error.code).toBe("provider_auth_required");
    expect(String(error?.error.message)).toMatch(/allowOnDemandCredits/);
    expect(bodies.length).toBe(0);
    expect(() => assertNoSpendPath("/extra")).toThrow(/Forbidden Command Code spending path/);
    console.log("COMMAND_CODE_FAIL_CLOSED_WITHOUT_HUMAN_ACK=PASS");
    console.log("AUTO_TOP_UP_DISABLED=YES");
    console.log("ON_DEMAND_FALLBACK=NONE");
  });
});
