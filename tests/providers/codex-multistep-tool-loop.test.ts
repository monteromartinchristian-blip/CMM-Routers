import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterMessage, RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * MULTI-STEP Codex dynamic-tool loop.
 *
 * The canonical proof: ONE Codex thread, ONE Codex turn, TWO sequential
 * external tool calls. The fake app-server is CAUSAL — it emits tool B only
 * after it observes Qoder's result A on the production wire (the JSON-RPC
 * response the Router writes back for the original item/tool/call), and it
 * emits the final answer only after it observes result B. No test pushes a
 * tool call directly; the harness decides each step from the wire.
 */

const THREAD = "thread-multi";
const TURN = "turn-multi";
const WIRE_A = 901;
const WIRE_B = 902;

interface Seen {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function contentTextOf(result: Record<string, unknown>): string {
  const items = result.contentItems as Array<{ text?: string }> | undefined;
  return items?.[0]?.text ?? "";
}

class MultiStepCodexServer {
  readonly seen: Seen[] = [];
  readonly toolCalls: Array<Record<string, unknown>> = [];
  /** Params of every item/tool/call this server EMITTED (same-turn proof). */
  readonly emittedToolParams: Array<Record<string, unknown>> = [];
  readonly wireAnswers: Array<{ id: unknown; success: boolean; text: string }> = [];
  readonly interrupts: Seen[] = [];
  threadStarts = 0;
  turnStarts = 0;
  /** When true, tool A is held until the test calls emitToolA(). */
  holdToolA = false;
  /**
   * How the SECOND step is decided once result A is observed on the wire.
   * "declared" | "undeclared" | "hold" (released by the test).
   */
  stepB: "declared" | "undeclared" | "hold" = "declared";
  readonly transport: Duplex;
  private textA: string | undefined;
  private toolAEmitted = false;
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
        result: { data: [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }] },
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
      if (!this.holdToolA) setTimeout(() => this.emitToolA(), 10);
      return;
    }
    if (msg.method === "turn/interrupt") {
      this.interrupts.push(msg);
      this.push({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    // A Router → app-server RESPONSE (no method) answers a parked tool call.
    if (msg.result !== undefined && msg.id === WIRE_A) {
      const success = msg.result.success === true;
      const text = contentTextOf(msg.result);
      this.wireAnswers.push({ id: msg.id, success, text });
      if (success) {
        this.textA = text;
        // CAUSALITY: step B is decided from the observed result A.
        if (this.stepB === "declared") setTimeout(() => this.emitToolB(), 5);
        if (this.stepB === "undeclared") setTimeout(() => this.emitUndeclaredToolB(), 5);
      }
      return;
    }
    if (msg.result !== undefined && msg.id === WIRE_B) {
      const success = msg.result.success === true;
      const text = contentTextOf(msg.result);
      this.wireAnswers.push({ id: msg.id, success, text });
      if (success) {
        // CAUSALITY: the final answer is derived from BOTH observed results.
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

  emitToolA(): void {
    if (this.toolAEmitted) return;
    this.toolAEmitted = true;
    const params = {
      arguments: '{"text":"A"}',
      callId: "call_codex_A",
      namespace: null,
      threadId: THREAD,
      turnId: TURN,
      tool: "cmm_echo",
    };
    this.toolCalls.push({ tool: "cmm_echo", callId: "call_codex_A" });
    this.emittedToolParams.push(params);
    this.push({ jsonrpc: "2.0", id: WIRE_A, method: "item/tool/call", params });
  }

  emitToolB(): void {
    if (this.toolBEmitted) return;
    this.toolBEmitted = true;
    const params = {
      arguments: '{"text":"B"}',
      callId: "call_codex_B",
      namespace: null,
      threadId: THREAD,
      turnId: TURN,
      tool: "cmm_echo",
    };
    this.toolCalls.push({ tool: "cmm_echo", callId: "call_codex_B" });
    this.emittedToolParams.push(params);
    this.push({ jsonrpc: "2.0", id: WIRE_B, method: "item/tool/call", params });
  }

  /** Step B naming a tool that was never declared on this thread. */
  emitUndeclaredToolB(): void {
    if (this.toolBEmitted) return;
    this.toolBEmitted = true;
    const params = {
      arguments: "{}",
      callId: "call_codex_evil",
      namespace: null,
      threadId: THREAD,
      turnId: TURN,
      tool: "run_command",
    };
    this.toolCalls.push({ tool: "run_command", callId: "call_codex_evil" });
    this.emittedToolParams.push(params);
    this.push({ jsonrpc: "2.0", id: WIRE_B, method: "item/tool/call", params });
  }
}

function makeAdapter(server: MultiStepCodexServer): {
  adapter: CodexAdapter;
  broker: DeferredToolBroker;
} {
  const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 60_000 });
  const adapter = new CodexAdapter({
    transportFactory: () => server.transport,
    broker,
  });
  return { adapter, broker };
}

function request(requestId: string, messages: RouterMessage[]): RouterRequest {
  return {
    requestId,
    model: {
      id: "chatgpt/gpt-5",
      provider: "chatgpt",
      upstreamModel: "gpt-5",
      displayName: "GPT-5",
      capability: "CHAT_AND_TOOLS",
    },
    messages,
    tools: [CMM_ECHO_TOOL],
    stream: true,
  };
}

function assistantCall(id: string, name: string, args: string): RouterMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id: string, content: string): RouterMessage {
  return { role: "tool", content, toolCallId: id };
}

async function collect(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) {
    out.push(event);
    if (event.type === "completed" || event.type === "error") break;
  }
  return out;
}

function textOf(events: RouterEvent[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { text: string }).text)
    .join("");
}

function toolDeltaOf(events: RouterEvent[]): { id: string; name?: string } {
  const delta = events.find((e) => e.type === "tool_call_delta");
  expect(delta).toBeDefined();
  return delta as unknown as { id: string; name?: string };
}

function clientOf(adapter: CodexAdapter): CodexAppServerClient {
  const client = (adapter as unknown as { client: CodexAppServerClient | null }).client;
  expect(client).not.toBeNull();
  return client!;
}

function interruptTargets(server: MultiStepCodexServer): string[] {
  return server.interrupts.map(
    (m) => `${String(m.params?.threadId)}/${String(m.params?.turnId)}`,
  );
}

/**
 * Terminal-state hygiene: no live provider run, no broker entry, no pending
 * cross-request tool waiter (the Codex analogue of a bridge-pending call), and
 * no public id that can still be resolved as a live call.
 */
function assertNoResidualState(
  adapter: CodexAdapter,
  client: CodexAppServerClient,
  broker: DeferredToolBroker,
  publicIds: string[],
): void {
  const adapterState = adapter as unknown as {
    activeTurns: Map<string, unknown>;
    parkedTurns: Map<string, unknown>;
  };
  expect(adapterState.activeTurns.size).toBe(0);
  expect(adapterState.parkedTurns.size).toBe(0);
  expect(broker.activeCount()).toBe(0);

  const clientState = client as unknown as {
    notificationWaiters: Array<{ threadId?: string; turnId?: string }>;
    serverRequestWaiters: Array<{ threadId?: string; turnId?: string }>;
  };
  expect(
    clientState.notificationWaiters.some(
      (w) => w.threadId === THREAD || w.turnId === TURN,
    ),
  ).toBe(false);
  expect(
    clientState.serverRequestWaiters.filter(
      (w) => w.threadId === THREAD || w.turnId === TURN,
    ).length,
  ).toBe(0);

  for (const publicId of publicIds) {
    const outcome = broker.claimByPublicToolCallId(publicId).outcome;
    expect(["duplicate", "stale"]).toContain(outcome);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex multi-step external tool loop (two sequential tools, one turn)", () => {
  it("completes TOOL_A then TOOL_B on the SAME thread and SAME turn", async () => {
    const server = new MultiStepCodexServer();
    const { adapter, broker } = makeAdapter(server);

    // Step 1: provider requests TOOL_A.
    const first = await collect(
      adapter.run(request("ms-1", [{ role: "user", content: "two steps" }]), new AbortController().signal),
    );
    const callA = toolDeltaOf(first);
    expect(callA.name).toBe("cmm_echo");
    expect(callA.id.startsWith("cmm_chatgpt_")).toBe(true);
    expect((first.find((e) => e.type === "completed") as { finishReason: string }).finishReason).toBe(
      "tool_calls",
    );
    // The original wire request is still pending: the Router never executes.
    expect(server.wireAnswers.length).toBe(0);

    // Step 2: Qoder returns result A on a follow-up request. The fake server
    // reacts to that wire result by requesting TOOL_B in the SAME thread/turn.
    const second = await collect(
      adapter.run(
        request("ms-2", [
          { role: "user", content: "two steps" },
          assistantCall(callA.id, "cmm_echo", '{"text":"A"}'),
          toolResult(callA.id, "RESULT_A=alpha"),
        ]),
        new AbortController().signal,
      ),
    );
    const callB = toolDeltaOf(second);
    expect(callB.id).not.toBe(callA.id);
    expect(callB.name).toBe("cmm_echo");
    expect((second.find((e) => e.type === "completed") as { finishReason: string }).finishReason).toBe(
      "tool_calls",
    );
    expect(server.wireAnswers[0]).toMatchObject({
      id: WIRE_A,
      success: true,
      text: "RESULT_A=alpha",
    });
    expect(server.toolCalls.map((c) => c.tool)).toEqual(["cmm_echo", "cmm_echo"]);

    // Step 3: Qoder returns result B; the SAME run continues to the answer.
    const third = await collect(
      adapter.run(
        request("ms-3", [
          { role: "user", content: "two steps" },
          assistantCall(callA.id, "cmm_echo", '{"text":"A"}'),
          toolResult(callA.id, "RESULT_A=alpha"),
          assistantCall(callB.id, "cmm_echo", '{"text":"B"}'),
          toolResult(callB.id, "RESULT_B=bravo"),
        ]),
        new AbortController().signal,
      ),
    );
    const finalText = textOf(third);
    expect(finalText).toBe("final:RESULT_A=alpha|RESULT_B=bravo");
    expect((third.find((e) => e.type === "completed") as { finishReason: string }).finishReason).toBe(
      "stop",
    );
    expect(server.wireAnswers[1]).toMatchObject({
      id: WIRE_B,
      success: true,
      text: "RESULT_B=bravo",
    });

    // ONE thread, ONE turn: no new thread and no new turn per tool.
    expect(server.threadStarts).toBe(1);
    expect(server.turnStarts).toBe(1);
    console.log("CODEX_TWO_SEQUENTIAL_TOOLS_SAME_THREAD=PASS");

    const toolCallParams = server.emittedToolParams;
    expect(toolCallParams.length).toBe(2);
    expect(toolCallParams.every((p) => p?.threadId === THREAD && p?.turnId === TURN)).toBe(true);
    console.log("CODEX_TWO_SEQUENTIAL_TOOLS_SAME_TURN=PASS");

    // Distinct public identity per step; provider-internal callIds preserved.
    expect(callA.id).not.toBe(callB.id);
    expect(toolCallParams.map((p) => p?.callId)).toEqual(["call_codex_A", "call_codex_B"]);
    console.log("CODEX_MULTISTEP_TOOL_CALL_ID_SPLIT=PASS");
    console.log("CODEX_MULTISTEP_FINAL_DERIVED_FROM_BOTH_RESULTS=PASS");
    console.log("BROKER_ACTIVE_CALLS=0");
    expect(broker.activeCount()).toBe(0);
  }, 30000);

  it("still enforces the declared-tool ACL on the SECOND tool request", async () => {
    const server = new MultiStepCodexServer();
    // The second step is decided causally: it is emitted only AFTER result A is
    // observed on the wire, and it names an undeclared tool.
    server.stepB = "undeclared";
    const { adapter } = makeAdapter(server);

    const first = await collect(
      adapter.run(request("acl-1", [{ role: "user", content: "two steps" }]), new AbortController().signal),
    );
    const callA = toolDeltaOf(first);

    // Only cmm_echo is declared on this thread, so step B must fail closed.
    const second = await collect(
      adapter.run(
        request("acl-2", [
          { role: "user", content: "two steps" },
          assistantCall(callA.id, "cmm_echo", '{"text":"A"}'),
          toolResult(callA.id, "RESULT_A=alpha"),
        ]),
        new AbortController().signal,
      ),
    );
    const error = second.find((e) => e.type === "error") as { error: { code: string } } | undefined;
    expect(error?.error.code).toBe("provider_protocol_error");
    expect(second.find((e) => e.type === "tool_call_delta")).toBeUndefined();
    const undeclaredAnswer = server.wireAnswers.find((a) => a.id === WIRE_B);
    expect(undeclaredAnswer?.success).toBe(false);
    expect(server.threadStarts).toBe(1);
    expect(server.turnStarts).toBe(1);
    console.log("CODEX_MULTISTEP_SECOND_TOOL_ACL_ENFORCED=PASS");
  }, 30000);
});

describe("Codex multi-step cancellation between tools", () => {
  it("cancel BEFORE tool A: no live run, no broker entry, no stale public id", async () => {
    const server = new MultiStepCodexServer();
    server.holdToolA = true;
    const { adapter, broker } = makeAdapter(server);

    const controller = new AbortController();
    const runPromise = collect(adapter.run(request("c-a", [{ role: "user", content: "hold" }]), controller.signal));
    await waitFor(() => server.seen.some((m) => m.method === "turn/start"));
    await tick(15);
    const client = clientOf(adapter);

    controller.abort();
    await adapter.cancel("c-a");
    await runPromise;

    expect(interruptTargets(server)).toEqual([`${THREAD}/${TURN}`]);
    assertNoResidualState(adapter, client, broker, []);
    console.log("MULTI_STEP_CANCEL_BEFORE_TOOL_A=PASS");
    console.log("CODEX_NO_LIVE_PROVIDER_RUN=PASS");
  }, 30000);

  it("cancel WHILE waiting result A: parked correlation and live turn are released", async () => {
    const server = new MultiStepCodexServer();
    const { adapter, broker } = makeAdapter(server);

    const first = await collect(
      adapter.run(request("c-b", [{ role: "user", content: "park" }]), new AbortController().signal),
    );
    const callA = toolDeltaOf(first);
    const client = clientOf(adapter);
    expect(broker.activeCount()).toBe(1);
    await tick(10);

    await adapter.cancel("c-b");
    expect(interruptTargets(server)).toEqual([`${THREAD}/${TURN}`]);
    assertNoResidualState(adapter, client, broker, [callA.id]);
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_A=PASS");
    console.log("CODEX_NO_LIVE_PROVIDER_RUN=PASS");
  }, 30000);

  it("cancel AFTER result A but BEFORE tool B (between tools)", async () => {
    const server = new MultiStepCodexServer();
    server.stepB = "hold";
    const { adapter, broker } = makeAdapter(server);

    const first = await collect(
      adapter.run(request("c-c1", [{ role: "user", content: "two steps" }]), new AbortController().signal),
    );
    const callA = toolDeltaOf(first);
    const client = clientOf(adapter);

    const controller = new AbortController();
    const secondPromise = collect(
      adapter.run(
        request("c-c2", [
          { role: "user", content: "two steps" },
          assistantCall(callA.id, "cmm_echo", '{"text":"A"}'),
          toolResult(callA.id, "RESULT_A=alpha"),
        ]),
        controller.signal,
      ),
    );
    // Wait until result A reached the app-server wire; tool B is still held.
    await waitFor(() => server.wireAnswers.some((a) => a.id === WIRE_A));
    await tick(15);
    expect(server.toolCalls.length).toBe(1);

    controller.abort();
    await adapter.cancel("c-c2");
    const second = await secondPromise;

    expect(second.find((e) => e.type === "completed")).toBeUndefined();
    expect(interruptTargets(server)).toEqual([`${THREAD}/${TURN}`]);
    assertNoResidualState(adapter, client, broker, [callA.id]);
    // Result A was consumed, so its public id is terminal, not replayable.
    expect(broker.claimByPublicToolCallId(callA.id).outcome).toBe("duplicate");
    console.log("MULTI_STEP_CANCEL_BETWEEN_TOOLS=PASS");
    console.log("CODEX_NO_LIVE_PROVIDER_RUN=PASS");
  }, 30000);

  it("cancel WHILE waiting result B: second parked call is released", async () => {
    const server = new MultiStepCodexServer();
    const { adapter, broker } = makeAdapter(server);

    const first = await collect(
      adapter.run(request("c-d1", [{ role: "user", content: "two steps" }]), new AbortController().signal),
    );
    const callA = toolDeltaOf(first);
    const client = clientOf(adapter);

    const second = await collect(
      adapter.run(
        request("c-d2", [
          { role: "user", content: "two steps" },
          assistantCall(callA.id, "cmm_echo", '{"text":"A"}'),
          toolResult(callA.id, "RESULT_A=alpha"),
        ]),
        new AbortController().signal,
      ),
    );
    const callB = toolDeltaOf(second);
    expect(callB.id).not.toBe(callA.id);
    expect(broker.activeCount()).toBe(1);
    // Result B was consumed from A's step; B is now the live parked call.
    expect(broker.claimByPublicToolCallId(callA.id).outcome).toBe("duplicate");
    await tick(10);

    await adapter.cancel("c-d2");
    expect(interruptTargets(server)).toEqual([`${THREAD}/${TURN}`]);
    assertNoResidualState(adapter, client, broker, [callB.id]);
    expect(broker.claimByPublicToolCallId(callB.id).outcome).toBe("stale");
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_B=PASS");
    console.log("CODEX_NO_LIVE_PROVIDER_RUN=PASS");
  }, 30000);
});
