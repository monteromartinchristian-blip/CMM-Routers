import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import {
  createFakeClaudeSdkMultiStep,
  type FakeClaudeSdkMultiStepOptions,
  type FakeClaudeSdkMultiStep,
} from "../helpers/fake-claude-sdk-multistep.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

/**
 * Multi-step proof: the SAME logical Claude Agent SDK run issues TOOL_A, waits
 * for Qoder's result A over the real MCP/bridge/control wire, and only then
 * issues TOOL_B (arguments derived from result A), waits for result B, and
 * finally answers from BOTH results.
 *
 * Causality is structural: step B's trigger is the arrival of result A through
 * the production transport, not a test-side gate. No `release()` or manual
 * final-answer emission exists anywhere in the harness.
 */

type ToolCallDelta = { id: string; name?: string; argumentsDelta?: string };

function request(requestId: string, messages: RouterRequest["messages"]): RouterRequest {
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

function continuation(requestId: string, callId: string, result: string): RouterRequest {
  return request(requestId, [
    { role: "user", content: "two steps" },
    { role: "tool", content: result, toolCallId: callId },
  ]);
}

interface RunHandle {
  events: RouterEvent[];
  next: () => Promise<IteratorResult<RouterEvent>>;
}

/** Start a run WITHOUT draining it: the adapter generator is kept live. */
function startRun(
  adapter: ClaudeAdapter,
  req: RouterRequest,
  signal: AbortSignal,
): RunHandle {
  const iterator = adapter.run(req, signal)[Symbol.asyncIterator]();
  const handle: RunHandle = {
    events: [],
    next: async () => {
      const result = await iterator.next();
      if (!result.done) handle.events.push(result.value);
      return result;
    },
  };
  return handle;
}

function toolCallsOf(events: RouterEvent[]): ToolCallDelta[] {
  return events.filter((e) => e.type === "tool_call_delta") as ToolCallDelta[];
}

function errorsOf(events: RouterEvent[]): unknown[] {
  return events.filter((e) => e.type === "error").map((e) => (e as { error: unknown }).error);
}

/** Human-readable error summary for assertion messages. */
function errorText(events: RouterEvent[]): string {
  const summaries = events
    .filter((e) => e.type === "error")
    .map((e) => {
      const err = (e as { error: unknown }).error as
        | { code?: string; message?: string }
        | undefined;
      return `${err?.code ?? "error"}: ${err?.message ?? ""}`;
    });
  return summaries.join(" | ");
}

/** Pull events until a tool_call_delta is surfaced (or the run ends). */
async function pumpToToolCall(handle: RunHandle): Promise<ToolCallDelta | undefined> {
  for (;;) {
    const { value, done } = await handle.next();
    if (done) return undefined;
    if (value.type === "tool_call_delta") return value as ToolCallDelta;
    if (value.type === "error") return undefined;
  }
}

/** Drain the run to its terminal event (completed/error) or completion. */
async function drainToTerminal(handle: RunHandle): Promise<RouterEvent[]> {
  for (;;) {
    const { value, done } = await handle.next();
    if (done) return handle.events;
    if (value.type === "completed" || value.type === "error") return handle.events;
  }
}

async function drainHandle(handle: RunHandle): Promise<void> {
  for (;;) {
    const { done } = await handle.next();
    if (done) return;
  }
}

async function collectEvents(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) {
    out.push(event);
    if (event.type === "completed" || event.type === "error") break;
  }
  return out;
}

interface Harness {
  adapter: ClaudeAdapter;
  broker: DeferredToolBroker;
  fakeA: FakeClaudeSdkMultiStep;
  fakeB: FakeClaudeSdkMultiStep;
  providerRuns: () => number;
}

/**
 * Two provider runs share one adapter, each with its OWN fake SDK (per-run MCP
 * child). The dispatcher binds the first provider run to fakeA and the second
 * to fakeB; multi-step continuations never start a new provider run.
 */
function harness(opts: {
  fakeA: FakeClaudeSdkMultiStepOptions;
  fakeB?: FakeClaudeSdkMultiStepOptions;
}): Harness {
  const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
  const fakeA = createFakeClaudeSdkMultiStep(opts.fakeA);
  const fakeB = createFakeClaudeSdkMultiStep(
    opts.fakeB ?? {
      toolA: { name: "cmm_echo", arguments: { text: "UNRELATED_B_ARG" } },
      toolBName: "cmm_echo",
      toolBArguments: (resultA) => ({ text: `UNRELATED_B_FROM_A:${resultA}` }),
    },
  );
  const fakes = [fakeA, fakeB];
  let runs = 0;
  const adapter = new ClaudeAdapter({
    broker,
    bridgeCommand: TSX,
    bridgeEntryPath: BRIDGE_ENTRY,
    queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) => {
      const fake = fakes[Math.min(runs, fakes.length - 1)]!;
      runs += 1;
      return fake.queryFn(args);
    }) as never,
  });
  return { adapter, broker, fakeA, fakeB, providerRuns: () => runs };
}

function stepAOptions(): FakeClaudeSdkMultiStepOptions {
  return {
    toolA: { name: "cmm_echo", arguments: { text: "STEP_A_ARG" } },
    toolBName: "cmm_echo",
    // Step B's arguments literally contain result A: only the provider could
    // have learned result A, and only from the real wire.
    toolBArguments: (resultA) => ({ text: `STEP_B_FROM_A:${resultA}` }),
    finalPrefix: "final:",
  };
}

/** Read-only view of Router-side bridge control frames (diagnostic). */
interface SessionInternals {
  control: { pendingCount(): number };
}

function bridgePending(adapter: ClaudeAdapter): number {
  const internals = adapter as unknown as {
    sessions: Map<string, SessionInternals>;
    sessionsByRequest: Map<string, SessionInternals>;
  };
  const seen = new Set<SessionInternals>();
  let total = 0;
  for (const session of [
    ...internals.sessions.values(),
    ...internals.sessionsByRequest.values(),
  ]) {
    if (seen.has(session)) continue;
    seen.add(session);
    total += session.control.pendingCount();
  }
  return total;
}

/** Live provider runs across parked AND in-flight continuations. */
function liveRuns(adapter: ClaudeAdapter): number {
  const internals = adapter as unknown as {
    sessions: Map<string, unknown>;
    sessionsByRequest: Map<string, unknown>;
  };
  const seen = new Set<unknown>(internals.sessions.values());
  for (const session of internals.sessionsByRequest.values()) seen.add(session);
  return seen.size;
}

interface ParkedUnrelated {
  requestId: string;
  publicId: string;
  handle: RunHandle;
}

/** Park an UNRELATED second session so cancellation tests prove it survives. */
async function parkUnrelatedSession(h: Harness): Promise<ParkedUnrelated> {
  const handle = startRun(
    h.adapter,
    request("ms-unrelated-1", [{ role: "user", content: "unrelated" }]),
    new AbortController().signal,
  );
  const delta = await pumpToToolCall(handle);
  if (!delta) throw new Error("unrelated session never surfaced a tool call");
  return { requestId: "ms-unrelated-1", publicId: delta.id, handle };
}

async function teardownUnrelated(h: Harness, parked: ParkedUnrelated): Promise<void> {
  await h.adapter.cancel(parked.requestId);
  await drainHandle(parked.handle);
  expect(h.adapter.activeToolSessions()).toBe(0);
  expect(h.broker.activeCount()).toBe(0);
  expect(bridgePending(h.adapter)).toBe(0);
}

/** The cancelled session must leave ZERO state while the unrelated one lives. */
function expectCancelledClean(h: Harness, unrelated: ParkedUnrelated): void {
  expect(h.fakeA.wasAborted(), "cancelled provider run must be aborted").toBe(true);
  expect(h.fakeB.wasAborted(), "unrelated provider run must survive").toBe(false);
  expect(h.adapter.activeToolSessions()).toBe(1);
  expect(liveRuns(h.adapter)).toBe(1);
  expect(h.broker.activeCount()).toBe(1);
  expect(bridgePending(h.adapter)).toBe(1);
  expect(unrelated.publicId.startsWith("cmm_claude_")).toBe(true);
  console.log("CLAUDE_CANCELLED_RUN_LIVE_PROVIDER_RUNS=0");
  console.log("CLAUDE_CANCELLED_RUN_BROKER_ENTRIES=0");
  console.log("CLAUDE_CANCELLED_RUN_BRIDGE_PENDING=0");
  console.log("CLAUDE_UNRELATED_CONCURRENT_SESSION=SURVIVES");
}

/** A terminal public id must never resolve a later continuation. */
async function expectPublicIdNotClaimable(
  h: Harness,
  publicId: string,
  providerRunsBefore: number,
): Promise<void> {
  const events = await collectEvents(
    h.adapter.run(
      continuation("stale-probe", publicId, "late-result"),
      new AbortController().signal,
    ),
  );
  const error = errorsOf(events)[0];
  expect(error, `public id ${publicId} must not resolve any pending call`).toBeDefined();
  expect(
    (error as { code?: string }).code,
    "an orphaned tool result must fail closed as a protocol error",
  ).toBe("provider_protocol_error");
  expect(h.providerRuns()).toBe(providerRunsBefore);
  console.log("CLAUDE_STALE_PUBLIC_TOOL_ID=REJECTED");
}

describe("Claude multi-step sequential MCP tool loop", () => {
  it("runs TOOL_A then TOOL_B sequentially inside ONE logical Claude run", async () => {
    const RESULT_A = "TOOL_A_WIRE_CANARY_5c31";
    const RESULT_B = "TOOL_B_WIRE_CANARY_9e07";
    const h = harness({ fakeA: stepAOptions() });
    const { adapter, broker, fakeA } = h;

    // ---- Exchange 1: the fake SDK speaks real MCP and parks TOOL_A ----
    const first = startRun(
      adapter,
      request("ms-1", [{ role: "user", content: "two steps please" }]),
      new AbortController().signal,
    );
    const firstEvents = await drainToTerminal(first);
    const deltaA = toolCallsOf(firstEvents)[0];
    expect(deltaA, errorText(firstEvents)).toBeDefined();
    expect(deltaA!.name).toBe("cmm_echo");
    expect(JSON.parse(deltaA!.argumentsDelta ?? "{}")).toEqual({ text: "STEP_A_ARG" });
    expect(firstEvents.find((e) => e.type === "completed")).toMatchObject({
      finishReason: "tool_calls",
    });
    expect(fakeA.consumedMcpConfig()).toBe(true);
    expect(fakeA.declaredTools()).toContain("cmm_echo");
    expect(fakeA.toolCallCount()).toBe(1);
    expect(fakeA.resultA()).toBeUndefined();
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("CLAUDE_MULTISTEP_TOOL_A_SURFACED=PASS");

    // ---- Exchange 2: result A over the REAL wire; only now does the
    // provider decide to request B, with arguments derived from result A ----
    const second = startRun(
      adapter,
      continuation("ms-2", deltaA!.id, RESULT_A),
      new AbortController().signal,
    );
    const secondEvents = await drainToTerminal(second);
    const deltaB = toolCallsOf(secondEvents)[0];
    expect(deltaB, errorText(secondEvents)).toBeDefined();
    expect(fakeA.resultA()).toBe(RESULT_A);
    expect(JSON.parse(deltaB!.argumentsDelta ?? "{}")).toEqual({
      text: `STEP_B_FROM_A:${RESULT_A}`,
    });
    const stages = fakeA.stages();
    expect(stages.indexOf("result-a-received")).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf("result-a-received")).toBeLessThan(stages.indexOf("tool-b-sent"));
    expect(fakeA.toolCallCount()).toBe(2);
    expect(secondEvents.find((e) => e.type === "completed")).toMatchObject({
      finishReason: "tool_calls",
    });
    expect(adapter.activeToolSessions()).toBe(1);
    console.log("CLAUDE_TOOL_A_RESULT_THEN_TOOL_B=PASS");

    // ---- Exchange 3: result B -> final answer derived from BOTH results ----
    const third = startRun(
      adapter,
      continuation("ms-3", deltaB!.id, RESULT_B),
      new AbortController().signal,
    );
    const thirdEvents = await drainToTerminal(third);
    expect(errorsOf(thirdEvents)).toEqual([]);
    const finalText = thirdEvents
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(finalText).toContain(`A=${RESULT_A}`);
    expect(finalText).toContain(`B=${RESULT_B}`);
    expect(fakeA.finalText()).toBe(`final:A=${RESULT_A}|B=${RESULT_B}`);
    expect(thirdEvents.find((e) => e.type === "completed")).toMatchObject({
      finishReason: "stop",
    });
    expect(h.providerRuns()).toBe(1);
    expect(adapter.activeToolSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    expect(bridgePending(adapter)).toBe(0);
    console.log("CLAUDE_TWO_SEQUENTIAL_TOOLS_SAME_LOGICAL_RUN=PASS");
    console.log("CLAUDE_FINAL_TEXT_DERIVED_FROM_BOTH_RESULTS=PASS");
    console.log("CLAUDE_ONE_PROVIDER_RUN_FOR_TWO_TOOLS=PASS");
  }, 60000);

  it("still refuses a PARALLEL unresolved call while sequential calls proceed", async () => {
    const RESULT_A = "PARALLEL_PROBE_RESULT_A_77b1";
    const RESULT_B = "PARALLEL_PROBE_RESULT_B_22d4";
    const h = harness({
      fakeA: { ...stepAOptions(), concurrentProbe: true },
    });
    const { adapter, broker, fakeA } = h;

    const first = startRun(
      adapter,
      request("par-1", [{ role: "user", content: "parallel probe" }]),
      new AbortController().signal,
    );
    const firstEvents = await drainToTerminal(first);
    const deltaA = toolCallsOf(firstEvents)[0];
    expect(deltaA, errorText(firstEvents)).toBeDefined();

    await fakeA.awaitStage("concurrent-probe-settled");
    const probe = fakeA.concurrentProbeOutcome();
    expect(probe?.outcome).toBe("rejected");
    expect(probe?.message ?? "").toContain("concurrent tool calls are not supported");
    console.log("CLAUDE_PARALLEL_UNRESOLVED_CALL_REFUSED=PASS");

    // The first call is still answerable: sequential step B must now work.
    const second = startRun(
      adapter,
      continuation("par-2", deltaA!.id, RESULT_A),
      new AbortController().signal,
    );
    const secondEvents = await drainToTerminal(second);
    const deltaB = toolCallsOf(secondEvents)[0];
    expect(deltaB, errorText(secondEvents)).toBeDefined();

    const third = startRun(
      adapter,
      continuation("par-3", deltaB!.id, RESULT_B),
      new AbortController().signal,
    );
    const thirdEvents = await drainToTerminal(third);
    expect(errorsOf(thirdEvents)).toEqual([]);
    const finalText = thirdEvents
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(finalText).toContain(`A=${RESULT_A}`);
    expect(finalText).toContain(`B=${RESULT_B}`);
    expect(fakeA.toolCallCount()).toBe(2);
    expect(adapter.activeToolSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    console.log("CLAUDE_CONCURRENCY_SAFETY_PRESERVED=PASS");
    console.log("CLAUDE_TWO_SEQUENTIAL_TOOLS_SAME_LOGICAL_RUN=PASS");
  }, 60000);

  it("keeps the Router free of any provider-facing MCP process ownership", async () => {
    const { readFileSync } = await import("node:fs");
    const adapterSource = readFileSync(join(REPO, "src/providers/claude/adapter.ts"), "utf-8");
    expect(adapterSource).not.toMatch(new RegExp(["spa", "wn\\("].join("")));
    expect(adapterSource).toMatch(/mcpServers/);
    console.log("CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk");
  });
});

describe("Claude multi-step cancellation coverage", () => {
  it("cancels BEFORE tool A with zero residual state", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const h = harness({ fakeA: { ...stepAOptions(), holdBeforeToolA: () => hold } });
    const handle = startRun(
      h.adapter,
      request("cxl-pre-1", [{ role: "user", content: "two steps" }]),
      new AbortController().signal,
    );
    // Keep draining in the background so the SDK reaches the pre-tool hold.
    const pump = drainHandle(handle);
    await h.fakeA.awaitStage("handshake-done");
    expect(liveRuns(h.adapter)).toBe(1);
    const unrelated = await parkUnrelatedSession(h);
    expect(liveRuns(h.adapter)).toBe(2);
    const runsBefore = h.providerRuns();

    const cancelPromise = h.adapter.cancel("cxl-pre-1");
    releaseHold?.();
    await cancelPromise;
    await pump;

    expectCancelledClean(h, unrelated);
    // The provider never issued a tool call, so no public id was ever minted.
    expect(h.fakeA.toolCallCount()).toBe(0);
    expect(h.providerRuns()).toBe(runsBefore);
    console.log("MULTI_STEP_CANCEL_PRE_TOOL=PASS");
    await teardownUnrelated(h, unrelated);
  }, 60000);

  it("cancels WHILE waiting for result A", async () => {
    const h = harness({ fakeA: stepAOptions() });
    const handle = startRun(
      h.adapter,
      request("cxl-wait-a-1", [{ role: "user", content: "two steps" }]),
      new AbortController().signal,
    );
    const deltaA = await pumpToToolCall(handle);
    expect(deltaA).toBeDefined();
    expect(h.adapter.activeToolSessions()).toBe(1);
    const unrelated = await parkUnrelatedSession(h);
    expect(h.adapter.activeToolSessions()).toBe(2);
    const runsBefore = h.providerRuns();

    await h.adapter.cancel("cxl-wait-a-1");
    await drainHandle(handle);

    expectCancelledClean(h, unrelated);
    await expectPublicIdNotClaimable(h, deltaA!.id, runsBefore);
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_A=PASS");
    await teardownUnrelated(h, unrelated);
  }, 60000);

  it("cancels BETWEEN result A and tool B", async () => {
    const RESULT_A = "CANCEL_BETWEEN_A_CANARY_3a77";
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const h = harness({ fakeA: { ...stepAOptions(), holdAfterResultA: () => hold } });
    const handleA1 = startRun(
      h.adapter,
      request("cxl-between-1", [{ role: "user", content: "two steps" }]),
      new AbortController().signal,
    );
    const deltaA = await pumpToToolCall(handleA1);
    expect(deltaA).toBeDefined();
    const unrelated = await parkUnrelatedSession(h);

    const handleA2 = startRun(
      h.adapter,
      continuation("cxl-between-2", deltaA!.id, RESULT_A),
      new AbortController().signal,
    );
    const kick = handleA2.next();
    await h.fakeA.awaitStage("result-a-received");
    expect(h.fakeA.resultA()).toBe(RESULT_A);
    // Step B is NOT requested yet: the provider is held between the steps.
    expect(h.fakeA.toolCallCount()).toBe(1);
    const runsBefore = h.providerRuns();

    const cancelPromise = h.adapter.cancel("cxl-between-2");
    releaseHold?.();
    await cancelPromise;
    await kick;
    await drainHandle(handleA2);
    await drainHandle(handleA1);

    expectCancelledClean(h, unrelated);
    expect(h.fakeA.toolCallCount()).toBe(1);
    await expectPublicIdNotClaimable(h, deltaA!.id, runsBefore);
    console.log("MULTI_STEP_CANCEL_BETWEEN_TOOLS=PASS");
    await teardownUnrelated(h, unrelated);
  }, 60000);

  it("cancels WHILE waiting for result B", async () => {
    const RESULT_A = "CANCEL_WAIT_B_RESULT_A_81f0";
    const h = harness({ fakeA: stepAOptions() });
    const handleA1 = startRun(
      h.adapter,
      request("cxl-wait-b-1", [{ role: "user", content: "two steps" }]),
      new AbortController().signal,
    );
    const deltaA = await pumpToToolCall(handleA1);
    expect(deltaA).toBeDefined();
    const unrelated = await parkUnrelatedSession(h);

    const handleA2 = startRun(
      h.adapter,
      continuation("cxl-wait-b-2", deltaA!.id, RESULT_A),
      new AbortController().signal,
    );
    const deltaB = await pumpToToolCall(handleA2);
    expect(deltaB, "sequential tool B must be parked").toBeDefined();
    expect(h.fakeA.resultA()).toBe(RESULT_A);
    expect(h.fakeA.toolCallCount()).toBe(2);
    expect(h.adapter.activeToolSessions()).toBe(2);
    const runsBefore = h.providerRuns();

    await h.adapter.cancel("cxl-wait-b-2");
    await drainHandle(handleA2);
    await drainHandle(handleA1);

    expectCancelledClean(h, unrelated);
    await expectPublicIdNotClaimable(h, deltaB!.id, runsBefore);
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_B=PASS");
    await teardownUnrelated(h, unrelated);
  }, 60000);

  it("cancels AFTER result B but before the final answer", async () => {
    const RESULT_A = "CANCEL_AFTER_B_RESULT_A_40c2";
    const RESULT_B = "CANCEL_AFTER_B_RESULT_B_6d19";
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const h = harness({ fakeA: { ...stepAOptions(), holdAfterResultB: () => hold } });
    const handleA1 = startRun(
      h.adapter,
      request("cxl-after-b-1", [{ role: "user", content: "two steps" }]),
      new AbortController().signal,
    );
    const deltaA = await pumpToToolCall(handleA1);
    expect(deltaA).toBeDefined();
    const unrelated = await parkUnrelatedSession(h);

    const handleA2 = startRun(
      h.adapter,
      continuation("cxl-after-b-2", deltaA!.id, RESULT_A),
      new AbortController().signal,
    );
    const deltaB = await pumpToToolCall(handleA2);
    expect(deltaB, "sequential tool B must be parked").toBeDefined();
    expect(h.fakeA.toolCallCount()).toBe(2);

    const handleA3 = startRun(
      h.adapter,
      continuation("cxl-after-b-3", deltaB!.id, RESULT_B),
      new AbortController().signal,
    );
    const kick = handleA3.next();
    await h.fakeA.awaitStage("result-b-received");
    expect(h.fakeA.resultB()).toBe(RESULT_B);
    expect(h.fakeA.finalText()).toBeUndefined();
    const runsBefore = h.providerRuns();

    const cancelPromise = h.adapter.cancel("cxl-after-b-3");
    releaseHold?.();
    await cancelPromise;
    await kick;
    await drainHandle(handleA3);
    await drainHandle(handleA2);
    await drainHandle(handleA1);

    expectCancelledClean(h, unrelated);
    expect(h.fakeA.finalText()).toBeUndefined();
    await expectPublicIdNotClaimable(h, deltaB!.id, runsBefore);
    console.log("MULTI_STEP_CANCEL_AFTER_TOOL_B_RESULT=PASS");
    await teardownUnrelated(h, unrelated);
  }, 60000);
});
