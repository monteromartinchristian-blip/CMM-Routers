import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  AntigravityAdapter,
  SpawnInferenceRunner,
  type InferenceRunner,
} from "../../src/providers/antigravity/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest, RouterTool } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");
const FAKE_AGY_MULTISTEP = join(import.meta.dirname, "../helpers/fake-agy-multistep.js");

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of [
    "CMM_TEST_TSX",
    "CMM_TEST_LAUNCHER",
    "CMM_TEST_TOOL_A",
    "CMM_TEST_TOOL_B",
    "CMM_TEST_HOLD_BEFORE_B_MS",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.CMM_TEST_TSX = TSX;
  process.env.CMM_TEST_LAUNCHER = LAUNCHER_TS;
  process.env.CMM_TEST_TOOL_A = "cmm_echo";
  process.env.CMM_TEST_TOOL_B = "cmm_echo";
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function req(
  requestId: string,
  messages: RouterRequest["messages"],
  tools: RouterTool[] = [CMM_ECHO_TOOL],
): RouterRequest {
  return {
    requestId,
    model: {
      id: "google/test-model",
      provider: "google",
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/** Real SpawnInferenceRunner whose child command is the multi-step fixture. */
function multistepRunner(graceMs = 200): { pids: number[]; runner: InferenceRunner } {
  const inner = new SpawnInferenceRunner(process.execPath, { terminationGraceMs: graceMs });
  const pids: number[] = [];
  return {
    pids,
    runner: {
      runInference: (args, options) => inner.runInference([FAKE_AGY_MULTISTEP, ...args], options),
      streamInference: (args, options, onEvent) =>
        inner.streamInference(
          [FAKE_AGY_MULTISTEP, ...args],
          {
            ...options,
            onSpawn: (pid) => {
              pids.push(pid);
              options.onSpawn?.(pid);
            },
          },
          onEvent,
        ),
    },
  };
}

function adapterFor(fake: ReturnType<typeof multistepRunner>, broker: DeferredToolBroker): AntigravityAdapter {
  return new AntigravityAdapter(fake.runner, undefined, {
    broker,
    bridgeCommand: TSX,
    bridgeLauncherPath: LAUNCHER_TS,
    mcpRegistrar: () => undefined,
    sessionTtlMs: 30000,
  });
}

const textOf = (events: RouterEvent[]): string =>
  events
    .filter((e): e is Extract<RouterEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

describe("Antigravity multi-step Qoder agent loop", () => {
  it("performs two sequential tool calls in the SAME agy run and derives the final answer from both", async () => {
    const fake = multistepRunner();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = adapterFor(fake, broker);
    const user: RouterRequest["messages"] = [{ role: "user", content: "go" }];

    const first = await collect(adapter.run(req("ms-1", user), new AbortController().signal));
    const deltaA = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
    expect(deltaA).toBeDefined();

    const second = await collect(
      adapter.run(
        req("ms-2", [...user, { role: "tool", content: "RESULT_A", toolCallId: deltaA!.id }]),
        new AbortController().signal,
      ),
    );
    const deltaB = second.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
    expect(deltaB).toBeDefined();
    expect(deltaB!.id).not.toBe(deltaA!.id);

    const third = await collect(
      adapter.run(
        req("ms-3", [
          ...user,
          { role: "tool", content: "RESULT_A", toolCallId: deltaA!.id },
          { role: "tool", content: "RESULT_B", toolCallId: deltaB!.id },
        ]),
        new AbortController().signal,
      ),
    );
    const finalText = textOf(third);
    expect(finalText).toContain("final:RESULT_A|RESULT_B");
    expect(third.some((e) => e.type === "completed")).toBe(true);

    // Exactly one agy process was spawned: both tools ran on the SAME run.
    expect(fake.pids).toHaveLength(1);
    await waitFor(() => adapter.activeToolSessions() === 0, 10000);
    expect(adapter.liveRendezvousSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);

    console.log("ANTIGRAVITY_TOOL_A_RESULT_THEN_TOOL_B=PASS");
    console.log("ANTIGRAVITY_TWO_SEQUENTIAL_TOOLS_SAME_AGY_RUN=PASS");
    console.log("MULTI_STEP_QODER_AGENT_LOOP_GOOGLE=PASS");
  }, 60000);

  it("cancels BETWEEN tool A and tool B with full cleanup", async () => {
    process.env.CMM_TEST_HOLD_BEFORE_B_MS = "6000";
    const fake = multistepRunner();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = adapterFor(fake, broker);
    const user: RouterRequest["messages"] = [{ role: "user", content: "go" }];
    try {
      const first = await collect(adapter.run(req("msc-1", user), new AbortController().signal));
      const deltaA = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(deltaA).toBeDefined();
      const pid = fake.pids[0] as number;

      // Request 2 delivers result A; the fixture then holds before tool B.
      const second = (async () => {
        for await (const _e of adapter.run(
          req("msc-2", [...user, { role: "tool", content: "RESULT_A", toolCallId: deltaA!.id }]),
          new AbortController().signal,
        )) {
          // drain
        }
      })();
      await waitFor(() => broker.activeCount() === 0, 10000);
      expect(alive(pid)).toBe(true);

      await adapter.cancel("msc-2");
      await waitFor(() => !alive(pid), 10000);
      expect(alive(pid)).toBe(false);
      await second;
      await waitFor(() => adapter.activeToolSessions() === 0, 5000);
      expect(adapter.activeToolSessions()).toBe(0);
      expect(adapter.liveRendezvousSessions()).toBe(0);
      expect(broker.activeCount()).toBe(0);
      console.log("MULTI_STEP_CANCEL_BETWEEN_TOOLS=PASS");
    } finally {
      delete process.env.CMM_TEST_HOLD_BEFORE_B_MS;
    }
  }, 60000);

  it("cancels while WAITING for result A with full cleanup", async () => {
    const fake = multistepRunner();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = adapterFor(fake, broker);
    const user: RouterRequest["messages"] = [{ role: "user", content: "go" }];

    const first = await collect(adapter.run(req("mswa-1", user), new AbortController().signal));
    expect(first.find((e) => e.type === "tool_call_delta")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(1);
    const pid = fake.pids[0] as number;

    await adapter.cancel("mswa-1");
    await waitFor(() => !alive(pid), 10000);
    expect(alive(pid)).toBe(false);
    await waitFor(() => adapter.activeToolSessions() === 0, 5000);
    expect(adapter.activeToolSessions()).toBe(0);
    expect(adapter.liveRendezvousSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_A=PASS");
  }, 60000);

  it("cancels while WAITING for result B with full cleanup", async () => {
    const fake = multistepRunner();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = adapterFor(fake, broker);
    const user: RouterRequest["messages"] = [{ role: "user", content: "go" }];

    const first = await collect(adapter.run(req("msw-1", user), new AbortController().signal));
    const deltaA = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
    expect(deltaA).toBeDefined();
    const pid = fake.pids[0] as number;

    // Request 2 parks tool B and returns; the provider now waits for result B.
    const second = await collect(
      adapter.run(
        req("msw-2", [...user, { role: "tool", content: "RESULT_A", toolCallId: deltaA!.id }]),
        new AbortController().signal,
      ),
    );
    expect(second.find((e) => e.type === "tool_call_delta")).toBeDefined();
    expect(adapter.activeToolSessions()).toBe(1);

    await adapter.cancel("msw-2");
    await waitFor(() => !alive(pid), 10000);
    expect(alive(pid)).toBe(false);
    await waitFor(() => adapter.activeToolSessions() === 0, 5000);
    expect(adapter.activeToolSessions()).toBe(0);
    expect(adapter.liveRendezvousSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    console.log("MULTI_STEP_CANCEL_WAITING_TOOL_B=PASS");
    console.log("MULTI_STEP_FINAL_CLEANUP=PASS");
  }, 60000);
});
