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
 * TWO-STEP (sequential, not parallel) Command Code OpenAI-wire tool loop.
 *
 * The fake upstream is provider-faithful: it does NOT hand the test tool B.
 * It inspects the REAL production request body of each continuation and only
 * emits tool B once it observes tool result A (with the exact id tool A was
 * surfaced with) carried in the history. A third request is answered only if
 * BOTH ordered pairs (assistant tool_calls A + result A, assistant tool_calls
 * B + result B) are present. Otherwise it fails the request closed with 400,
 * so a status-only assertion cannot pass.
 */

const TOOL_A_ID = "call_two_step_A";
const TOOL_B_ID = "call_two_step_B";
const ARG_A = '{"text":"alpha"}';
const ARG_B = '{"text":"beta"}';
const SENTINEL_A = "alpha_sentinel_7f3a91";
const SENTINEL_B = "beta_sentinel_9b2c47";
const RESULT_A = `RESULT_A=${SENTINEL_A}`;
const RESULT_B = `RESULT_B=${SENTINEL_B}`;

const MODEL = {
  id: "command-code/two-step-model",
  provider: "command-code" as const,
  upstreamModel: "two-step-model",
  displayName: "two-step-model",
  capability: "CHAT_AND_TOOLS" as const,
};

interface UpstreamMessage extends Record<string, unknown> {
  role?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

function openAiSse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

function toolCallFrame(id: string, name: string, args: string): Record<string, unknown> {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
        },
      },
    ],
  };
}

function textFrame(text: string): Record<string, unknown> {
  return { choices: [{ delta: { content: text } }] };
}

function finishFrame(reason: string): Record<string, unknown> {
  return { choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
}

function assistantIndexFor(messages: UpstreamMessage[], id: string): number {
  return messages.findIndex(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((c) => c?.id === id),
  );
}

function toolIndexFor(messages: UpstreamMessage[], id: string): number {
  return messages.findIndex((m) => m.role === "tool" && m.tool_call_id === id);
}

describe("Command Code OpenAI wire: two-step sequential tool loop", () => {
  let dir: string;
  let ackPath: string;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-2step-openai-"));
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
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: UpstreamMessage[];
        };
        bodies.push(body as Record<string, unknown>);
        calls += 1;
        const messages = body.messages ?? [];
        if (calls === 1) {
          return { status: 200, text: async () => openAiSse([toolCallFrame(TOOL_A_ID, "cmm_echo", ARG_A), finishFrame("tool_calls")]) };
        }
        if (calls === 2) {
          // Causality gate: tool B is only produced once result A is visible
          // in the production request body, with the exact tool A id.
          const assistantA = assistantIndexFor(messages, TOOL_A_ID);
          const toolA = toolIndexFor(messages, TOOL_A_ID);
          if (assistantA === -1 || toolA === -1 || assistantA > toolA) {
            return { status: 400, text: async () => "missing ordered assistant tool_calls A + tool result A" };
          }
          const carried = messages[toolA]!;
          if (carried.content !== RESULT_A) {
            return { status: 400, text: async () => "tool result A value not preserved" };
          }
          return { status: 200, text: async () => openAiSse([toolCallFrame(TOOL_B_ID, "cmm_echo", ARG_B), finishFrame("tool_calls")]) };
        }
        if (calls === 3) {
          const assistantA = assistantIndexFor(messages, TOOL_A_ID);
          const toolA = toolIndexFor(messages, TOOL_A_ID);
          const assistantB = assistantIndexFor(messages, TOOL_B_ID);
          const toolB = toolIndexFor(messages, TOOL_B_ID);
          if (assistantA === -1 || toolA === -1 || assistantB === -1 || toolB === -1) {
            return { status: 400, text: async () => "second-step history incomplete" };
          }
          if (!(assistantA < toolA && toolA < assistantB && assistantB < toolB)) {
            return { status: 400, text: async () => "second-step history reordered" };
          }
          if (messages[toolA]!.content !== RESULT_A || messages[toolB]!.content !== RESULT_B) {
            return { status: 400, text: async () => "tool results not preserved in order" };
          }
          return {
            status: 200,
            text: async () => openAiSse([textFrame(`${RESULT_A} ${RESULT_B}`), finishFrame("stop")]),
          };
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
    return { requestId, model: MODEL, messages, tools: [CMM_ECHO_TOOL], stream: false };
  }

  function completedReason(events: RouterEvent[]): string | undefined {
    const completed = events.find((e) => e.type === "completed");
    return completed === undefined ? undefined : (completed as { finishReason: string }).finishReason;
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

  it("surfaces tool A, then tool B only after result A, then a final answer derived from both", async () => {
    const adapter = twoStepAdapter();

    // ---- Step 0: the opening turn surfaces tool call A.
    const turn1 = await drain(adapter, request([{ role: "user", content: "run both steps" }], "two-step-1"));
    const callA = assembledToolCall(turn1);
    expect(callA).toEqual({ id: TOOL_A_ID, name: "cmm_echo", args: ARG_A });
    expect(completedReason(turn1)).toBe("tool_calls");

    // ---- Step 1: Qoder returns result A; the upstream then requests tool B.
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
        "two-step-2",
      ),
    );
    const callB = assembledToolCall(turn2);
    expect(callB).toEqual({ id: TOOL_B_ID, name: "cmm_echo", args: ARG_B });
    expect(completedReason(turn2)).toBe("tool_calls");
    // The upstream only returned B because it SAW result A: the second
    // production body carried assistant tool_calls A with result A.
    expect(bodies.length).toBe(2);
    const secondMessages = (bodies[1] as { messages: UpstreamMessage[] }).messages;
    expect(secondMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(secondMessages[1]!.tool_calls?.[0]?.id).toBe(TOOL_A_ID);
    expect(secondMessages[1]!.tool_calls?.[0]?.function?.arguments).toBe(ARG_A);
    expect(secondMessages[2]!.tool_call_id).toBe(TOOL_A_ID);
    expect(secondMessages[2]!.content).toBe(RESULT_A);

    // ---- Step 2: Qoder returns result B; the final answer derives from A and B.
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
        "two-step-3",
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

    // Exact ids + ordering preserved with no dropped blocks in the third body.
    expect(bodies.length).toBe(3);
    const thirdMessages = (bodies[2] as { messages: UpstreamMessage[] }).messages;
    expect(thirdMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(thirdMessages[1]!.tool_calls?.[0]?.id).toBe(TOOL_A_ID);
    expect(thirdMessages[2]!.tool_call_id).toBe(TOOL_A_ID);
    expect(thirdMessages[3]!.tool_calls?.[0]?.id).toBe(TOOL_B_ID);
    expect(thirdMessages[4]!.tool_call_id).toBe(TOOL_B_ID);

    console.log("COMMAND_CODE_OPENAI_TWO_STEP_SEQUENTIAL=YES");
    console.log("COMMAND_CODE_OPENAI_TOOL_B_CAUSED_BY_RESULT_A=YES");
    console.log("COMMAND_CODE_OPENAI_TOOL_ID_PRESERVED=YES");
    console.log("COMMAND_CODE_OPENAI_HISTORY_ORDER_PRESERVED=YES");
    console.log("COMMAND_CODE_OPENAI_TWO_STEP_TOOL_LOOP=PASS");
  });

  it("keeps the pinned spend policy: fail-closed without human ack, no on-demand path", async () => {
    // Reuses the existing spend-guard contract assertions: the same
    // acknowledgement schema and the same forbidden spending paths that the
    // command-code-spend-guard suite pins. No production behaviour changed.
    const bad = join(dir, "bad-ack.json");
    writeFileSync(
      bad,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: true }),
    );
    const adapter = new CommandCodeAdapter({
      ackPath: bad,
      client: new CommandCodeClient({
        secret: "goat-secret",
        fetchFn: (async () => ({ status: 200, text: async () => openAiSse([finishFrame("stop")]) })) as never,
      }),
    });
    const events = await drain(adapter, request([{ role: "user", content: "hi" }], "two-step-ack"));
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
