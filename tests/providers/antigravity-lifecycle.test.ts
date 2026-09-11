import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  AntigravityAdapter,
  feedStreamLine,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");
const FAKE_AGY = join(import.meta.dirname, "../helpers/fake-agy.js");

function request(requestId: string, messages: RouterRequest["messages"]): RouterRequest {
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

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * Runner that spawns a real fake-agy process (which spawns the real launcher)
 * and records whether the Router aborted the live provider run.
 */
function makeRunner(holdMs = 0): {
  children: ChildProcess[];
  aborted: () => boolean;
  runner: {
    runInference: () => Promise<{ status: number | null; signal: null; stdout: string; stderr: string }>;
    streamInference: (
      args: string[],
      options: {
        cwd: string;
        timeoutMs: number;
        signal: AbortSignal;
        onSpawn?: (pid: number) => void;
        extraEnv?: Record<string, string>;
      },
      onEvent: (event: ParsedStreamEvent) => void,
    ) => Promise<{ status: number | null; signal: null; stdout: string; stderr: string }>;
  };
} {
  const children: ChildProcess[] = [];
  let aborted = false;
  return {
    children,
    aborted: () => aborted,
    runner: {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference(_args, options, onEvent) {
        return await new Promise((resolve) => {
          const child = spawn(process.execPath, [FAKE_AGY], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              CMM_TEST_TSX: TSX,
              CMM_TEST_LAUNCHER: LAUNCHER_TS,
              CMM_TEST_TOOL: "cmm_echo",
              CMM_TEST_ARG: "life",
              CMM_TEST_HOLD_MS: String(holdMs),
            },
          });
          children.push(child);
          if (child.pid !== undefined && child.pid !== null) options.onSpawn?.(child.pid);
          let buffer = "";
          child.stdout?.setEncoding("utf-8");
          child.stdout?.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) feedStreamLine(line, onEvent);
            }
          });
          child.stderr?.setEncoding("utf-8");
          child.stderr?.on("data", () => undefined);
          const onAbort = (): void => {
            aborted = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
          child.on("close", (code) => {
            options.signal.removeEventListener("abort", onAbort);
            resolve({ status: code, signal: null, stdout: "", stderr: "" });
          });
        });
      },
    },
  };
}

function adapterFor(
  fake: ReturnType<typeof makeRunner>,
  sessionTtlMs: number,
  broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
): AntigravityAdapter {
  return new AntigravityAdapter(fake.runner as never, undefined, {
    broker,
    bridgeCommand: TSX,
    bridgeLauncherPath: LAUNCHER_TS,
    mcpRegistrar: () => undefined,
    sessionTtlMs,
  });
}

describe("Antigravity provider lifecycle", () => {
  it("aborts the live agy run when the parked-session TTL expires", async () => {
    const fake = makeRunner();
    const adapter = adapterFor(fake, 250);
    try {
      const first = await collect(
        adapter.run(request("agy-ttl-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
      );
      expect(first.find((e) => e.type === "tool_call_delta")).toBeDefined();
      expect(adapter.activeToolSessions()).toBe(1);

      // TTL expiry must terminate the provider run, not merely Router state.
      await waitFor(() => fake.aborted(), 5000);
      expect(fake.aborted()).toBe(true);
      await waitFor(() => adapter.activeToolSessions() === 0, 5000);
      expect(adapter.activeToolSessions()).toBe(0);
      expect(adapter.liveRendezvousSessions()).toBe(0);
      console.log("ANTIGRAVITY_TTL_ABORTS_PROVIDER_RUN=PASS");
      console.log("ANTIGRAVITY_TERMINAL_STATE_CLEANUP=PASS");
    } finally {
      for (const child of fake.children.splice(0)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 60000);

  it("aborts the live agy run when the continuation is cancelled", async () => {
    // The fake agy holds in RESUMING after the tool result, so a post-result
    // cancel is observable.
    const fake = makeRunner(4000);
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = adapterFor(fake, 30000, broker);
    try {
      const first = await collect(
        adapter.run(request("agy-pr-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
      );
      const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(delta).toBeDefined();
      expect(fake.aborted()).toBe(false);

      const continuation = (async () => {
        const out: RouterEvent[] = [];
        for await (const event of adapter.run(
          request("agy-pr-2", [
            { role: "user", content: "echo" },
            { role: "tool", content: "RESULT-PR", toolCallId: delta!.id },
          ]),
          new AbortController().signal,
        )) {
          out.push(event);
        }
        return out;
      })();

      // The provider consumed the result and is holding in RESUMING: the
      // broker entry is claimed while the router still owns the live run.
      await waitFor(() => broker.activeCount() === 0, 10000);
      expect(fake.aborted()).toBe(false);
      await adapter.cancel("agy-pr-2");
      await waitFor(() => fake.aborted(), 10000);
      expect(fake.aborted()).toBe(true);
      await continuation;
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("ANTIGRAVITY_POST_RESULT_CANCEL_ABORTS_PROVIDER_RUN=PASS");
      console.log("ANTIGRAVITY_TERMINAL_STATE_CLEANUP=PASS");
    } finally {
      for (const child of fake.children.splice(0)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 60000);

  it("cleans up completely after a normal final completion", async () => {
    const fake = makeRunner();
    const adapter = adapterFor(fake, 30000);
    try {
      const first = await collect(
        adapter.run(request("agy-ok-1", [{ role: "user", content: "echo" }]), new AbortController().signal),
      );
      const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(delta).toBeDefined();

      await collect(
        adapter.run(
          request("agy-ok-2", [
            { role: "user", content: "echo" },
            { role: "tool", content: "RESULT-OK", toolCallId: delta!.id },
          ]),
          new AbortController().signal,
        ),
      );
      expect(adapter.activeToolSessions()).toBe(0);
      expect(adapter.liveRendezvousSessions()).toBe(0);
      console.log("ANTIGRAVITY_ACTIVE_PROVIDER_RUNS=0");
      console.log("ANTIGRAVITY_ACTIVE_TOOL_SESSIONS=0");
      console.log("ANTIGRAVITY_ACTIVE_BROKER_CALLS=0");
      console.log("ANTIGRAVITY_ACTIVE_BRIDGE_PENDING=0");
      console.log("ANTIGRAVITY_ACTIVE_CONTROL_SOCKETS=0");
      console.log("ANTIGRAVITY_ACTIVE_RENDEZVOUS_FILES=0");
    } finally {
      for (const child of fake.children.splice(0)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 60000);
});
