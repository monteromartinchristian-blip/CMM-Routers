import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AntigravityAdapter,
  SpawnInferenceRunner,
  type InferenceRunner,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import { CappedTextBuffer } from "../../src/providers/antigravity/process-client.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");
const FAKE_AGY = join(import.meta.dirname, "../helpers/fake-agy.js");
const IGNORE_SIGINT = join(import.meta.dirname, "../helpers/ignore-sigint-provider.js");
const OVERSIZE_LINE = join(import.meta.dirname, "../helpers/oversize-line-provider.js");

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ["CMM_TEST_TSX", "CMM_TEST_LAUNCHER", "CMM_TEST_TOOL", "CMM_TEST_ARG"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.CMM_TEST_TSX = TSX;
  process.env.CMM_TEST_LAUNCHER = LAUNCHER_TS;
  process.env.CMM_TEST_TOOL = "cmm_echo";
  process.env.CMM_TEST_ARG = "hardening";
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

function request(
  requestId: string,
  messages: RouterRequest["messages"],
  tools: RouterRequest["tools"] = [],
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

/** A registry double so these tests do not depend on the disk registry. */
const fakeRegistry = {
  register: () => (): void => undefined,
  liveCount: () => 0,
  maxLiveSessions: () => 64,
} as never;

/** Runner that floods parsed events synchronously, then waits for abort. */
function floodingRunner(count: number): {
  abortObserved: () => boolean;
  runner: InferenceRunner;
} {
  let aborted = false;
  return {
    abortObserved: () => aborted,
    runner: {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference(_args, options, onEvent) {
        if (options.onSpawn) options.onSpawn(process.pid);
        for (let i = 0; i < count; i += 1) {
          onEvent({ kind: "text", texts: [`flood-${i}`] });
        }
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) {
            aborted = true;
            resolve();
            return;
          }
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { status: null, signal: "SIGINT", stdout: "", stderr: "" };
      },
    },
  };
}

/** Real SpawnInferenceRunner wrapped to capture the provider pid. */
function pidCapturingRunner(graceMs = 200): { pids: number[]; runner: InferenceRunner } {
  const inner = new SpawnInferenceRunner(process.execPath, {
    terminationGraceMs: graceMs,
  });
  const pids: number[] = [];
  return {
    pids,
    runner: {
      runInference: (args, options) => inner.runInference([FAKE_AGY, ...args], options),
      streamInference: (args, options, onEvent) =>
        inner.streamInference(
          // The adapter passes only agy flags; the real child command is this
          // test's fixture script.
          [FAKE_AGY, ...args],
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

describe("Antigravity stream-queue overflow is fail-closed", () => {
  it("aborts the provider and emits one protocol error on the non-tool path", async () => {
    const fake = floodingRunner(1000);
    const adapter = new AntigravityAdapter(fake.runner, undefined, {
      mcpRegistrar: () => undefined,
      maxStreamEvents: 4,
    });
    const events = await collect(
      adapter.run(request("agy-ovf-plain", [{ role: "user", content: "hello" }]), new AbortController().signal),
    );
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(fake.abortObserved()).toBe(true);
    console.log("ANTIGRAVITY_STREAM_QUEUE_BOUND=PASS");
    console.log("ANTIGRAVITY_STREAM_OVERFLOW_OBSERVED=PASS");
    console.log("ANTIGRAVITY_STREAM_OVERFLOW_PROVIDER_ABORT=PASS");
    console.log("ANTIGRAVITY_STREAM_OVERFLOW_PROTOCOL_ERROR=PASS");
    console.log("ANTIGRAVITY_STREAM_OVERFLOW_SUCCESS_AFTER_ERROR=NONE");
  }, 30000);

  it("aborts the provider, cleans up and emits one protocol error on the tool path", async () => {
    const fake = floodingRunner(1000);
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = new AntigravityAdapter(fake.runner, undefined, {
      broker,
      registry: fakeRegistry,
      mcpRegistrar: () => undefined,
      maxStreamEvents: 4,
    });
    const events = await collect(
      adapter.run(
        request("agy-ovf-tools", [{ role: "user", content: "hello" }], [CMM_ECHO_TOOL]),
        new AbortController().signal,
      ),
    );
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(fake.abortObserved()).toBe(true);
    expect(adapter.activeToolSessions()).toBe(0);
    expect(adapter.liveRendezvousSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    console.log("ANTIGRAVITY_STREAM_OVERFLOW_CLEANUP=PASS");
  }, 30000);
});

describe("agy child termination guarantees process exit", () => {
  it("escalates SIGINT to SIGKILL on abort and observes child exit", async () => {
    const runner = new SpawnInferenceRunner(process.execPath, { terminationGraceMs: 300 });
    const controller = new AbortController();
    let pid: number | undefined;
    const events: ParsedStreamEvent[] = [];
    const resultPromise = runner.streamInference(
      [IGNORE_SIGINT],
      { cwd: tmpdir(), timeoutMs: 30000, signal: controller.signal, onSpawn: (p) => (pid = p) },
      (event) => events.push(event),
    );
    // Wait until the fixture has actually started (its first frame proves the
    // SIGINT handler is installed), otherwise SIGINT could arrive first and
    // terminate it by default action.
    await waitFor(() => pid !== undefined && events.length > 0);
    expect(alive(pid as number)).toBe(true);
    const started = Date.now();
    controller.abort();
    const result = await resultPromise;
    const elapsed = Date.now() - started;
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("SIGINT_SEEN");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5000);
    await waitFor(() => !alive(pid as number));
    expect(alive(pid as number)).toBe(false);
    console.log("AGY_ABORT_SIGINT_SENT=PASS");
    console.log("AGY_ABORT_GRACE_PERIOD_BOUNDED=PASS");
    console.log("AGY_ABORT_SIGKILL_ESCALATION=PASS");
    console.log("AGY_ABORT_CHILD_EXIT_OBSERVED=PASS");
    console.log("AGY_ABORT_PROCESS_EXIT=PASS");
  }, 30000);

  it("escalates SIGINT to SIGKILL on timeout and observes child exit", async () => {
    const runner = new SpawnInferenceRunner(process.execPath, { terminationGraceMs: 300 });
    let pid: number | undefined;
    const result = await runner.streamInference(
      [IGNORE_SIGINT],
      { cwd: tmpdir(), timeoutMs: 300, signal: new AbortController().signal, onSpawn: (p) => (pid = p) },
      () => undefined,
    );
    expect(result.error).toBeDefined();
    await waitFor(() => !alive(pid as number));
    expect(alive(pid as number)).toBe(false);
    console.log("AGY_TIMEOUT_SIGKILL_ESCALATION=PASS");
  }, 30000);

  it("guarantees provider process exit on TTL session cleanup (real runner)", async () => {
    const fake = pidCapturingRunner();
    const adapter = new AntigravityAdapter(fake.runner, undefined, {
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: () => undefined,
      sessionTtlMs: 400,
    });
    const first = await collect(
      adapter.run(request("agy-ttl-real", [{ role: "user", content: "echo" }], [CMM_ECHO_TOOL]), new AbortController().signal),
    );
    expect(first.find((e) => e.type === "tool_call_delta")).toBeDefined();
    expect(fake.pids.length).toBeGreaterThan(0);
    const pid = fake.pids[0] as number;
    await waitFor(() => adapter.activeToolSessions() === 0, 10000);
    await waitFor(() => !alive(pid), 10000);
    expect(alive(pid)).toBe(false);
    console.log("ANTIGRAVITY_TTL_GUARANTEES_PROVIDER_PROCESS_EXIT=PASS");
  }, 60000);

  it("guarantees provider process exit on post-result cancellation (real runner)", async () => {
    const previousHold = process.env.CMM_TEST_HOLD_MS;
    process.env.CMM_TEST_HOLD_MS = "8000";
    const fake = pidCapturingRunner();
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = new AntigravityAdapter(fake.runner, undefined, {
      broker,
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: () => undefined,
      sessionTtlMs: 30000,
    });
    try {
      const first = await collect(
        adapter.run(request("agy-pr-real-1", [{ role: "user", content: "echo" }], [CMM_ECHO_TOOL]), new AbortController().signal),
      );
      const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(delta).toBeDefined();
      const pid = fake.pids[0] as number;
      expect(alive(pid)).toBe(true);
      const continuation = (async () => {
        for await (const _event of adapter.run(
          request(
            "agy-pr-real-2",
            [
              { role: "user", content: "echo" },
              { role: "tool", content: "RESULT-REAL", toolCallId: delta!.id },
            ],
            [CMM_ECHO_TOOL],
          ),
          new AbortController().signal,
        )) {
          // drain
        }
      })();
      await waitFor(() => broker.activeCount() === 0, 10000);
      await adapter.cancel("agy-pr-real-2");
      await waitFor(() => !alive(pid), 10000);
      expect(alive(pid)).toBe(false);
      await continuation;
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("ANTIGRAVITY_POST_RESULT_CANCEL_GUARANTEES_PROVIDER_PROCESS_EXIT=PASS");
    } finally {
      if (previousHold === undefined) delete process.env.CMM_TEST_HOLD_MS;
      else process.env.CMM_TEST_HOLD_MS = previousHold;
    }
  }, 60000);
});

describe("agy raw provider output is bounded", () => {
  it("bounds the capped stdout/stderr diagnostic windows", () => {
    const buf = new CappedTextBuffer(100);
    for (let i = 0; i < 50; i += 1) buf.push("0123456789");
    expect(buf.value().length).toBeLessThanOrEqual(100);
    expect(buf.didOverflow()).toBe(true);
    console.log("AGY_STDOUT_ACCUMULATOR_BOUNDED=PASS");
    console.log("AGY_STDERR_ACCUMULATOR_BOUNDED=PASS");
  });

  it("fails closed on an oversize unterminated NDJSON line", async () => {
    const runner = new SpawnInferenceRunner(process.execPath, {
      maxNdjsonLineBytes: 2048,
      maxStdoutDiagnosticBytes: 1024,
      maxStderrDiagnosticBytes: 1024,
      terminationGraceMs: 200,
    });
    const events: ParsedStreamEvent[] = [];
    let pid: number | undefined;
    const previous = process.env.CMM_TEST_LINE_BYTES;
    process.env.CMM_TEST_LINE_BYTES = "65536";
    try {
      const result = await runner.streamInference(
        [OVERSIZE_LINE],
        { cwd: tmpdir(), timeoutMs: 20000, signal: new AbortController().signal, onSpawn: (p) => (pid = p) },
        (event) => events.push(event),
      );
      const protocolErrors = events.filter((e) => e.kind === "protocolError");
      expect(protocolErrors).toHaveLength(1);
      expect(result.stdout.length).toBeLessThanOrEqual(1024);
      await waitFor(() => !alive(pid as number));
      expect(alive(pid as number)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CMM_TEST_LINE_BYTES;
      else process.env.CMM_TEST_LINE_BYTES = previous;
    }
    console.log("AGY_NDJSON_PARTIAL_LINE_BOUNDED=PASS");
    console.log("AGY_OVERSIZE_NDJSON_FAIL_CLOSED=PASS");
  }, 30000);
});
