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

const ARG_A = "ARG-A-7713";
const ARG_B = "ARG-B-9924";

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

interface FakeRunner {
  children: ChildProcess[];
  spawnedPids: number[];
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
}

/**
 * A runner that spawns a real fake-agy process (which itself spawns the real
 * MCP launcher). This makes the launcher a descendant of an exact, distinct
 * provider pid — exactly the production topology.
 */
function makeFakeAgyRunner(arg: string): FakeRunner {
  const children: ChildProcess[] = [];
  const spawnedPids: number[] = [];
  return {
    children,
    spawnedPids,
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
              CMM_TEST_ARG: arg,
            },
          });
          children.push(child);
          if (child.pid !== undefined) {
            spawnedPids.push(child.pid);
            options.onSpawn?.(child.pid);
          }
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
          const onAbort = () => {
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


async function collect(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) {
    out.push(event);
    if (event.type === "completed" || event.type === "error") break;
  }
  return out;
}

describe("Antigravity concurrent MCP tool sessions", () => {
  it("routes two overlapping runs to their own session without cross-talk", async () => {
    const runnerA = makeFakeAgyRunner(ARG_A);
    const runnerB = makeFakeAgyRunner(ARG_B);
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });

    const adapterA = new AntigravityAdapter(runnerA.runner as never, undefined, {
      broker,
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: () => undefined,
    });
    const adapterB = new AntigravityAdapter(runnerB.runner as never, undefined, {
      broker,
      bridgeCommand: TSX,
      bridgeLauncherPath: LAUNCHER_TS,
      mcpRegistrar: () => undefined,
    });

    try {
      // Both runs are live at the same time.
      const firstA = collect(
        adapterA.run(request("agy-A1", [{ role: "user", content: "echo A" }]), new AbortController().signal),
      );
      const firstB = collect(
        adapterB.run(request("agy-B1", [{ role: "user", content: "echo B" }]), new AbortController().signal),
      );

      const [eventsA, eventsB] = await Promise.all([firstA, firstB]);

      const deltaA = eventsA.find((e) => e.type === "tool_call_delta") as
        | { id: string; name: string; argumentsDelta: string }
        | undefined;
      const deltaB = eventsB.find((e) => e.type === "tool_call_delta") as
        | { id: string; name: string; argumentsDelta: string }
        | undefined;

      // Every distinct provider pid must resolve to its own session.
      expect(runnerA.spawnedPids.length).toBe(1);
      expect(runnerB.spawnedPids.length).toBe(1);
      expect(runnerA.spawnedPids[0]).not.toBe(runnerB.spawnedPids[0]);

      expect(deltaA).toBeDefined();
      expect(deltaB).toBeDefined();
      expect(deltaA!.argumentsDelta).toBe(JSON.stringify({ text: ARG_A }));
      expect(deltaB!.argumentsDelta).toBe(JSON.stringify({ text: ARG_B }));
      expect(deltaA!.id).not.toBe(deltaB!.id);
      console.log("ANTIGRAVITY_TWO_CONCURRENT_TOOL_SESSIONS=PASS");

      // ---- A's result must release ONLY A; B's only B ----
      const followA = collect(
        adapterA.run(
          request("agy-A2", [
            { role: "user", content: "echo A" },
            { role: "tool", content: "RESULT-A", toolCallId: deltaA!.id },
          ]),
          new AbortController().signal,
        ),
      );
      const followB = collect(
        adapterB.run(
          request("agy-B2", [
            { role: "user", content: "echo B" },
            { role: "tool", content: "RESULT-B", toolCallId: deltaB!.id },
          ]),
          new AbortController().signal,
        ),
      );

      const [secondA, secondB] = await Promise.all([followA, followB]);
      const textA = secondA
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      const textB = secondB
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join("");

      // Each provider's final text comes from its OWN tool result only.
      expect(textA).toContain("final:RESULT-A");
      expect(textA).not.toContain("RESULT-B");
      expect(textB).toContain("final:RESULT-B");
      expect(textB).not.toContain("RESULT-A");
      console.log("ANTIGRAVITY_CROSS_RUN_RESULT_ISOLATION=PASS");
      console.log("ANTIGRAVITY_CONCURRENT_LAUNCHER_ISOLATION=PASS");
      console.log("E2E_PROVIDER_CONTINUATION_CAUSALLY_DEPENDS_ON_TOOL_RESULT=PASS");
    } finally {
      for (const child of [...runnerA.children, ...runnerB.children]) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }
  }, 120000);
});
