import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * ROUTER-LEVEL two-step (sequential) Qoder agent loop on Command Code.
 *
 * Three REAL HTTP exchanges against /v1/chat/completions drive the full loop.
 * The fake Command Code upstream is provider-faithful: it inspects the REAL
 * production request body of the continuation exchange and only emits tool
 * call B once it observes the tool result for A with the exact id, in order.
 * The third exchange is answered only when both ordered pairs are present;
 * otherwise the upstream fails closed with 400. A status-only assertion
 * therefore cannot pass.
 *
 * Covered wires: OpenAI chat-completions (default) and Anthropic Messages
 * (selected by the model-family routing rule).
 */

const QODER_TOKEN = "cc-multistep-qoder-token";
const OPENAI_MODEL = "command-code/goat-model-a";
const ANTHROPIC_MODEL = "command-code/claude-two-step";

const TOOL_A_ID = "call_http_step_A";
const TOOL_B_ID = "call_http_step_B";
const TOOL_A_ID_ANTHROPIC = "toolu_http_step_A";
const TOOL_B_ID_ANTHROPIC = "toolu_http_step_B";
const ARG_A = '{"text":"alpha"}';
const ARG_B = '{"text":"beta"}';
const RESULT_A = "RESULT_A=alpha_sentinel_7f3a91";
const RESULT_B = "RESULT_B=beta_sentinel_9b2c47";

interface Recorded {
  wire: "openai" | "anthropic";
  body: Record<string, unknown>;
}

type WireMessage = Record<string, unknown>;

function openAiSse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

function anthropicSse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

function openAiToolFrame(id: string, args: string): Record<string, unknown> {
  return {
    choices: [
      { delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "cmm_echo", arguments: args } }] } },
    ],
  };
}

function openAiFinish(reason: string): Record<string, unknown> {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function anthropicToolStream(id: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "cmm_echo" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text":' } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: `"${id.endsWith("A") ? "alpha" : "beta"}"}` },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}

function anthropicTextStream(text: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_stop" },
  ];
}

/**
 * Interleaved ordered id sequence seen in one production request body:
 * "use:<id>" for an assistant tool_use / tool_calls entry and
 * "result:<id>" for the matching tool result. Wire-faithful per wire.
 */
function orderedIds(wire: Recorded["wire"], body: Record<string, unknown>): string[] {
  const messages = (body.messages ?? []) as WireMessage[];
  const sequence: string[] = [];
  for (const message of messages) {
    if (wire === "openai") {
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as WireMessage[]) : [];
      for (const call of calls) {
        if (typeof call.id === "string") sequence.push(`use:${call.id}`);
      }
      if (message.role === "tool" && typeof message.tool_call_id === "string") {
        sequence.push(`result:${message.tool_call_id}`);
      }
      continue;
    }
    const content = Array.isArray(message.content) ? (message.content as WireMessage[]) : [];
    for (const block of content) {
      if (block.type === "tool_use" && typeof block.id === "string") sequence.push(`use:${block.id}`);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        sequence.push(`result:${block.tool_use_id}`);
      }
    }
  }
  return sequence;
}

function toolResultContent(wire: Recorded["wire"], body: Record<string, unknown>, id: string): string | undefined {
  const messages = (body.messages ?? []) as WireMessage[];
  for (const message of messages) {
    if (wire === "openai") {
      if (message.role === "tool" && message.tool_call_id === id) return String(message.content ?? "");
      continue;
    }
    const content = Array.isArray(message.content) ? (message.content as WireMessage[]) : [];
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id === id) return String(block.content ?? "");
    }
  }
  return undefined;
}

describe("Router HTTP: Command Code multi-step Qoder agent tool loop", () => {
  let dir: string;
  let ackPath: string;
  let recorded: Recorded[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-http-2step-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
    recorded = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Provider-faithful Command Code upstream for BOTH wires. */
  function upstream(): { calls: { openai: number; anthropic: number } } {
    return { calls: { openai: 0, anthropic: 0 } };
  }

  function adapterWith(counter: { calls: { openai: number; anthropic: number } }): CommandCodeAdapter {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (url: string, init: { body?: string }) => {
        if (url.endsWith("/models")) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                data: [
                  { id: "goat-model-a", display_name: "Goat A", goatIncluded: true },
                  { id: "claude-two-step", display_name: "Claude Two Step", goatIncluded: true },
                ],
              }),
          };
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (url.endsWith("/chat/completions")) {
          counter.calls.openai += 1;
          recorded.push({ wire: "openai", body });
          const call = counter.calls.openai;
          if (call === 1) {
            return { status: 200, text: async () => openAiSse([openAiToolFrame(TOOL_A_ID, ARG_A), openAiFinish("tool_calls")]) };
          }
          if (call === 2) {
            const ids = orderedIds("openai", body);
            if (IDS_A_OPENAI.join("|") !== ids.join("|")) {
              return { status: 400, text: async () => `expected ordered result A in body, saw ${ids.join(",")}` };
            }
            if (toolResultContent("openai", body, TOOL_A_ID) !== RESULT_A) {
              return { status: 400, text: async () => "tool result A value not preserved" };
            }
            return { status: 200, text: async () => openAiSse([openAiToolFrame(TOOL_B_ID, ARG_B), openAiFinish("tool_calls")]) };
          }
          if (call === 3) {
            const ids = orderedIds("openai", body);
            if (IDS_AB_OPENAI.join("|") !== ids.join("|")) {
              return { status: 400, text: async () => `expected ordered A/B history, saw ${ids.join(",")}` };
            }
            if (toolResultContent("openai", body, TOOL_B_ID) !== RESULT_B) {
              return { status: 400, text: async () => "tool result B value not preserved" };
            }
            return {
              status: 200,
              text: async () =>
                openAiSse([
                  { choices: [{ delta: { content: `${RESULT_A} ${RESULT_B}` } }] },
                  openAiFinish("stop"),
                ]),
            };
          }
          return { status: 500, text: async () => "unexpected extra openai-wire call" };
        }
        if (url.endsWith("/messages")) {
          counter.calls.anthropic += 1;
          recorded.push({ wire: "anthropic", body });
          const call = counter.calls.anthropic;
          if (call === 1) {
            return { status: 200, text: async () => anthropicSse(anthropicToolStream(TOOL_A_ID_ANTHROPIC)) };
          }
          if (call === 2) {
            const ids = orderedIds("anthropic", body);
            if (IDS_A_ANTHROPIC.join("|") !== ids.join("|")) {
              return { status: 400, text: async () => `expected ordered tool_result A in body, saw ${ids.join(",")}` };
            }
            if (toolResultContent("anthropic", body, TOOL_A_ID_ANTHROPIC) !== RESULT_A) {
              return { status: 400, text: async () => "tool_result A value not preserved" };
            }
            return { status: 200, text: async () => anthropicSse(anthropicToolStream(TOOL_B_ID_ANTHROPIC)) };
          }
          if (call === 3) {
            const ids = orderedIds("anthropic", body);
            if (IDS_AB_ANTHROPIC.join("|") !== ids.join("|")) {
              return { status: 400, text: async () => `expected ordered A/B history, saw ${ids.join(",")}` };
            }
            if (toolResultContent("anthropic", body, TOOL_B_ID_ANTHROPIC) !== RESULT_B) {
              return { status: 400, text: async () => "tool_result B value not preserved" };
            }
            return { status: 200, text: async () => anthropicSse(anthropicTextStream(`${RESULT_A} ${RESULT_B}`)) };
          }
          return { status: 500, text: async () => "unexpected extra anthropic-wire call" };
        }
        return { status: 404, text: async () => "unexpected endpoint" };
      }) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  const IDS_A_OPENAI = [`use:${TOOL_A_ID}`, `result:${TOOL_A_ID}`];
  const IDS_AB_OPENAI = [...IDS_A_OPENAI, `use:${TOOL_B_ID}`, `result:${TOOL_B_ID}`];
  const IDS_A_ANTHROPIC = [`use:${TOOL_A_ID_ANTHROPIC}`, `result:${TOOL_A_ID_ANTHROPIC}`];
  const IDS_AB_ANTHROPIC = [...IDS_A_ANTHROPIC, `use:${TOOL_B_ID_ANTHROPIC}`, `result:${TOOL_B_ID_ANTHROPIC}`];

  async function serverFor(counter: { calls: { openai: number; anthropic: number } }) {
    const registry = new ProviderRegistry();
    await registry.register(adapterWith(counter));
    await registry.refresh();
    return buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cmmchat",
      qoderToken: QODER_TOKEN,
      registry,
    });
  }

  type Server = Awaited<ReturnType<typeof serverFor>>;

  async function inject(
    server: Server,
    model: string,
    messages: Array<Record<string, unknown>>,
  ) {
    return await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: { model, messages, tools: [CMM_ECHO_TOOL] },
    });
  }

  type CallView = { id: string; name: string; arguments: string };

  function toolCallOf(response: { json: () => unknown }): CallView {
    const body = response.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    const call = body.choices[0]!.message.tool_calls![0]!;
    return { id: call.id, name: call.function.name, arguments: call.function.arguments };
  }

  function finalTextOf(response: { json: () => unknown }): { text: string; finish: string } {
    const body = response.json() as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    return { text: body.choices[0]!.message.content, finish: body.choices[0]!.finish_reason };
  }

  async function driveLoop(server: Server, model: string): Promise<void> {
    const user = { role: "user", content: "run both steps" };

    // Exchange 1: the opening turn surfaces tool call A over real HTTP.
    const first = await inject(server, model, [user]);
    expect(first.statusCode).toBe(200);
    const callA = toolCallOf(first);
    expect(callA.name).toBe("cmm_echo");
    expect(callA.arguments).toBe(ARG_A);

    // Exchange 2: Qoder returns result A; the upstream then requests B.
    const second = await inject(server, model, [
      user,
      { role: "assistant", content: null, tool_calls: [{ id: callA.id, type: "function", function: { name: callA.name, arguments: callA.arguments } }] },
      { role: "tool", content: RESULT_A, tool_call_id: callA.id },
    ]);
    expect(second.statusCode).toBe(200);
    const callB = toolCallOf(second);
    expect(callB.name).toBe("cmm_echo");
    expect(callB.arguments).toBe(ARG_B);
    expect(callB.id).not.toBe(callA.id);

    // Exchange 3: Qoder returns result B; the final answer derives from A+B.
    const third = await inject(server, model, [
      user,
      { role: "assistant", content: null, tool_calls: [{ id: callA.id, type: "function", function: { name: callA.name, arguments: callA.arguments } }] },
      { role: "tool", content: RESULT_A, tool_call_id: callA.id },
      { role: "assistant", content: null, tool_calls: [{ id: callB.id, type: "function", function: { name: callB.name, arguments: callB.arguments } }] },
      { role: "tool", content: RESULT_B, tool_call_id: callB.id },
    ]);
    expect(third.statusCode).toBe(200);
    const final = finalTextOf(third);
    expect(final.finish).toBe("stop");
    expect(final.text).toContain(RESULT_A);
    expect(final.text).toContain(RESULT_B);
  }

  it("drives the full two-step loop over HTTP on the OpenAI wire", async () => {
    const counter = upstream();
    const server = await serverFor(counter);
    await driveLoop(server, OPENAI_MODEL);
    expect(recorded.filter((r) => r.wire === "openai").length).toBe(3);
    const third = recorded.filter((r) => r.wire === "openai")[2]!;
    expect(orderedIds("openai", third.body)).toEqual(IDS_AB_OPENAI);
    console.log("HTTP_MULTISTEP_OPENAI_WIRE=PASS");
    console.log("HTTP_MULTISTEP_OPENAI_TOOL_IDS_PRESERVED=PASS");
    console.log("MULTI_STEP_QODER_AGENT_LOOP_COMMAND_CODE=PASS");
  });

  it("negative control: the upstream gate really fires when result A is absent over HTTP", async () => {
    // No test-only escape hatch: omitting the tool result for A makes the
    // provider-faithful upstream fail closed, and the router surfaces that
    // failure instead of a fabricated tool call B.
    const counter = upstream();
    const server = await serverFor(counter);
    const user = { role: "user", content: "run both steps" };
    const first = await inject(server, OPENAI_MODEL, [user]);
    expect(first.statusCode).toBe(200);
    const callA = toolCallOf(first);
    // Continuation WITHOUT result A (assistant history only).
    const second = await inject(server, OPENAI_MODEL, [
      user,
      { role: "assistant", content: null, tool_calls: [{ id: callA.id, type: "function", function: { name: callA.name, arguments: callA.arguments } }] },
    ]);
    expect(second.statusCode).toBe(500);
    expect((second.json() as { error: { type: string } }).error.type).toBe("provider_protocol_error");
    console.log("COMMAND_CODE_TWO_STEP_GATE_FAILS_CLOSED_WITHOUT_RESULT_A=PASS");
  });

  it("drives the full two-step loop over HTTP on the Anthropic wire", async () => {
    const counter = upstream();
    const server = await serverFor(counter);
    await driveLoop(server, ANTHROPIC_MODEL);
    expect(recorded.filter((r) => r.wire === "anthropic").length).toBe(3);
    const third = recorded.filter((r) => r.wire === "anthropic")[2]!;
    expect(orderedIds("anthropic", third.body)).toEqual(IDS_AB_ANTHROPIC);
    console.log("HTTP_MULTISTEP_ANTHROPIC_WIRE_SELECTION=PASS");
    console.log("HTTP_MULTISTEP_ANTHROPIC_TOOL_USE_IDS_PRESERVED=PASS");
    console.log("MULTI_STEP_QODER_AGENT_LOOP_COMMAND_CODE=PASS");
  });

  it("stays fail-closed without the human GOAT ack: no routing, no on-demand spend", async () => {
    // Reuses the existing spend-guard contract: a missing/invalid human
    // acknowledgement must block routing entirely (provider_auth_required ->
    // HTTP 401) and no upstream request may be attempted.
    const missing = join(dir, "absent-ack.json");
    expect(existsSync(missing)).toBe(false);
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (url: string) => {
        if (url.endsWith("/models")) {
          return {
            status: 200,
            text: async () => JSON.stringify({ data: [{ id: "goat-model-a", goatIncluded: true }] }),
          };
        }
        throw new Error(`upstream must not be called without human ack: ${url}`);
      }) as never,
    });
    const registry = new ProviderRegistry();
    await registry.register(new CommandCodeAdapter({ ackPath: missing, client }));
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cmmchat",
      qoderToken: QODER_TOKEN,
      registry,
    });
    const response = await inject(server, OPENAI_MODEL, [{ role: "user", content: "hi" }]);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { type: string } }).error.type).toBe("provider_auth_required");
    // No chat-completions request ever reached the upstream.
    expect(recorded.length).toBe(0);
    console.log("COMMAND_CODE_HTTP_FAIL_CLOSED_WITHOUT_HUMAN_ACK=PASS");
    console.log("AUTO_TOP_UP_DISABLED=YES");
    console.log("ON_DEMAND_FALLBACK=NONE");
  });
});
