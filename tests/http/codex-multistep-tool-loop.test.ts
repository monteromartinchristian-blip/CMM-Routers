import { describe, expect, it, beforeEach } from "vitest";
import { Duplex } from "node:stream";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * ROUTER-LEVEL proof of the multi-step Codex tool loop.
 *
 * Drives the real `/v1/chat/completions` route with a fake Codex app-server
 * transport and performs the full two-tool loop: tool A, tool B, final answer.
 * The fake transport is CAUSAL: tool B is requested only after the Router
 * writes result A back to the app-server, and the final message is composed
 * only after result B arrives on the same wire. The final text therefore
 * contains two independent canaries, both of which had to travel
 * Router → Qoder → Router → provider.
 */

const THREAD = "thread-http-multi";
const TURN = "turn-http-multi";
const WIRE_A = 901;
const WIRE_B = 902;
const MODEL = "chatgpt/test-model";

interface Seen {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function contentTextOf(result: Record<string, unknown>): string {
  const items = result.contentItems as Array<{ text?: string }> | undefined;
  return items?.[0]?.text ?? "";
}

class HttpMultiStepCodexServer {
  readonly seen: Seen[] = [];
  readonly wireAnswers: Array<{ id: unknown; success: boolean; text: string }> = [];
  threadStarts = 0;
  turnStarts = 0;
  readonly transport: Duplex;
  private textA: string | undefined;
  private toolBEmitted = false;

  constructor() {
    this.transport = new Duplex({
      read: () => {},
      write: (chunk: Buffer, _encoding: string, callback: () => void) => {
        this.onClientMessage(chunk.toString());
        callback();
      },
    });
  }

  private push(message: object): void {
    this.transport.push(`${JSON.stringify(message)}\n`);
  }

  private onClientMessage(raw: string): void {
    const msg = JSON.parse(raw) as Seen;
    this.seen.push(msg);

    if (msg.method === "initialize") {
      this.push({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "model/list") {
      this.push({
        jsonrpc: "2.0",
        id: msg.id,
        result: { data: [{ id: "test-model", model: "test-model", displayName: "Test Model" }] },
      });
      return;
    }
    if (msg.method === "thread/start") {
      this.threadStarts += 1;
      this.push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: THREAD } } });
      return;
    }
    if (msg.method === "thread/inject_items") {
      this.push({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "turn/start") {
      this.turnStarts += 1;
      this.push({
        jsonrpc: "2.0",
        id: msg.id,
        result: { turn: { id: TURN, status: "inProgress", items: [] } },
      });
      setTimeout(() => {
        this.push({
          jsonrpc: "2.0",
          id: WIRE_A,
          method: "item/tool/call",
          params: {
            arguments: '{"text":"A"}',
            callId: "call_codex_A",
            namespace: null,
            threadId: THREAD,
            turnId: TURN,
            tool: "cmm_echo",
          },
        });
      }, 10);
      return;
    }
    if (msg.method === "turn/interrupt") {
      this.push({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    if (msg.result !== undefined && msg.id === WIRE_A) {
      const success = msg.result.success === true;
      const text = contentTextOf(msg.result);
      this.wireAnswers.push({ id: msg.id, success, text });
      if (success) {
        this.textA = text;
        setTimeout(() => this.emitToolB(), 5);
      }
      return;
    }
    if (msg.result !== undefined && msg.id === WIRE_B) {
      const success = msg.result.success === true;
      const text = contentTextOf(msg.result);
      this.wireAnswers.push({ id: msg.id, success, text });
      if (success) {
        setTimeout(() => {
          this.push({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: {
              delta: `final:${this.textA ?? ""}|${text}`,
              itemId: "i-final",
              threadId: THREAD,
              turnId: TURN,
            },
          });
          this.push({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: TURN, status: "completed", items: [] } },
          });
        }, 5);
      }
      return;
    }
  }

  private emitToolB(): void {
    if (this.toolBEmitted) return;
    this.toolBEmitted = true;
    this.push({
      jsonrpc: "2.0",
      id: WIRE_B,
      method: "item/tool/call",
      params: {
        arguments: '{"text":"B"}',
        callId: "call_codex_B",
        namespace: null,
        threadId: THREAD,
        turnId: TURN,
        tool: "cmm_echo",
      },
    });
  }
}

interface ChatCompletionBody {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

describe("router /v1/chat/completions multi-step Codex tool loop", () => {
  const bearerSecret = "test-secret-http-multi";
  const qoderSecret = "qoder-secret-http-multi";
  let registry: ProviderRegistry;
  let server: ReturnType<typeof buildServer>;
  let fake: HttpMultiStepCodexServer;

  beforeEach(async () => {
    fake = new HttpMultiStepCodexServer();
    registry = new ProviderRegistry();
    const adapter = new CodexAdapter({ transportFactory: () => fake.transport });
    await registry.register(adapter);
    await registry.refresh();
    server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret,
      qoderToken: qoderSecret,
      registry,
    });
  });

  async function post(payload: object): Promise<{ status: number; body: ChatCompletionBody }> {
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload,
    });
    return { status: response.statusCode, body: response.json() as ChatCompletionBody };
  }

  it("performs TOOL_A then TOOL_B and answers with both results on one thread/turn", async () => {
    // Step 1 — the caller's turn; the provider requests the first dynamic tool.
    const first = await post({
      model: MODEL,
      messages: [{ role: "user", content: "two sequential steps" }],
      tools: [CMM_ECHO_TOOL],
    });
    expect(first.status).toBe(200);
    expect(first.body.choices[0]!.finish_reason).toBe("tool_calls");
    const callA = first.body.choices[0]!.message.tool_calls![0]!;
    expect(callA.function.name).toBe("cmm_echo");
    expect(callA.id.startsWith("cmm_chatgpt_")).toBe(true);
    expect(fake.wireAnswers.length).toBe(0);

    // Step 2 — Qoder returns result A; the provider requests TOOL_B.
    const second = await post({
      model: MODEL,
      messages: [
        { role: "user", content: "two sequential steps" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: '{"text":"A"}' } },
          ],
        },
        { role: "tool", tool_call_id: callA.id, content: "RESULT_A=alpha" },
      ],
      tools: [CMM_ECHO_TOOL],
    });
    expect(second.status).toBe(200);
    expect(second.body.choices[0]!.finish_reason).toBe("tool_calls");
    const callB = second.body.choices[0]!.message.tool_calls![0]!;
    expect(callB.function.name).toBe("cmm_echo");
    expect(callB.id).not.toBe(callA.id);
    expect(fake.wireAnswers[0]).toMatchObject({
      id: WIRE_A,
      success: true,
      text: "RESULT_A=alpha",
    });

    // Step 3 — Qoder returns result B; the SAME thread/turn produces the
    // final answer, which depends on BOTH results.
    const third = await post({
      model: MODEL,
      messages: [
        { role: "user", content: "two sequential steps" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callA.id, type: "function", function: { name: "cmm_echo", arguments: '{"text":"A"}' } },
          ],
        },
        { role: "tool", tool_call_id: callA.id, content: "RESULT_A=alpha" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callB.id, type: "function", function: { name: "cmm_echo", arguments: '{"text":"B"}' } },
          ],
        },
        { role: "tool", tool_call_id: callB.id, content: "RESULT_B=bravo" },
      ],
      tools: [CMM_ECHO_TOOL],
    });
    expect(third.status).toBe(200);
    expect(third.body.choices[0]!.finish_reason).toBe("stop");
    expect(third.body.choices[0]!.message.content).toBe(
      "final:RESULT_A=alpha|RESULT_B=bravo",
    );
    expect(third.body.choices[0]!.message.content).toContain("RESULT_A=alpha");
    expect(third.body.choices[0]!.message.content).toContain("RESULT_B=bravo");
    expect(fake.wireAnswers[1]).toMatchObject({
      id: WIRE_B,
      success: true,
      text: "RESULT_B=bravo",
    });

    // No new thread and no new turn for either tool step.
    expect(fake.threadStarts).toBe(1);
    expect(fake.turnStarts).toBe(1);
    console.log("MULTI_STEP_QODER_AGENT_LOOP_CODEX=PASS");
    console.log("MULTI_STEP_HTTP_SAME_THREAD=PASS");
    console.log("MULTI_STEP_HTTP_SAME_TURN=PASS");
  }, 30000);
});
