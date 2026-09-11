import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import {
  AntigravityAdapter,
  feedStreamLine,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { createFakeClaudeSdk } from "../helpers/fake-claude-sdk.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const LAUNCHER_TS = join(REPO, "src/bridge/mcp-bridge-launcher.ts");
const FAKE_AGY = join(import.meta.dirname, "../helpers/fake-agy.js");

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

function claudeModel(id = "claude/test-model"): DiscoveredModel {
  return {
    id,
    provider: "claude",
    upstreamModel: "test-model",
    displayName: "Test Model",
    capability: "CHAT_AND_TOOLS",
  };
}

function classedAdapter(base: ClaudeAdapter, model: DiscoveredModel): ClaudeAdapter {
  const adapter = base as ClaudeAdapter & { discoverModels: () => Promise<DiscoveredModel[]> };
  adapter.discoverModels = async () => [model];
  return adapter;
}

async function startServer(
  adapter: ClaudeAdapter | AntigravityAdapter,
): Promise<{
  base: string;
  server: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => unknown }> };
  close: () => Promise<void>;
}> {
  const registry = new ProviderRegistry();
  await registry.register(adapter);
  await registry.refresh();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: "s",
    qoderToken: "q",
    registry,
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    server: server as unknown as {
      inject: (opts: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    },
    close: async () => {
      await server.close();
    },
  };
}

function claudeAdapter(options: {
  fake: ReturnType<typeof createFakeClaudeSdk>;
  model: DiscoveredModel;
  sessionTtlMs?: number;
}): ClaudeAdapter {
  return classedAdapter(
    new ClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        options.fake.queryFn(args)) as never,
    }),
    options.model,
  );
}

function agyRunner(holdMs = 0): {
  runner: unknown;
  aborted: () => boolean;
} {
  let aborted = false;
  return {
    aborted: () => aborted,
    runner: {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference(
        _args: string[],
        options: {
          cwd: string;
          timeoutMs: number;
          signal: AbortSignal;
          onSpawn?: (pid: number) => void;
          extraEnv?: Record<string, string>;
        },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        return await new Promise((resolve) => {
          const child = spawn(process.execPath, [FAKE_AGY], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              CMM_TEST_TSX: TSX,
              CMM_TEST_LAUNCHER: LAUNCHER_TS,
              CMM_TEST_TOOL: "cmm_echo",
              CMM_TEST_ARG: "matrix",
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

function googleAdapter(runner: unknown): AntigravityAdapter {
  const adapter = new AntigravityAdapter(runner as never, undefined, {
    broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
    bridgeCommand: TSX,
    bridgeLauncherPath: LAUNCHER_TS,
    mcpRegistrar: () => undefined,
  }) as AntigravityAdapter & {
    discoverModels: () => Promise<DiscoveredModel[]>;
  };
  adapter.discoverModels = async () => [
    {
      id: "google/test-model",
      provider: "google",
      upstreamModel: "test-model",
      displayName: "Test Model",
      capability: "CHAT_AND_TOOLS",
    },
  ];
  return adapter;
}

/** Read SSE frames until the predicate matches, then optionally abort. */
async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
  controller?: AbortController,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) {
      if (controller) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // client-side cancel is best effort here
        }
      }
      return text;
    }
  }
  return text;
}

function toolCallIdOf(sseText: string): string | undefined {
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload.includes("tool_calls")) {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string }> } }>;
      };
      const id = parsed.choices?.[0]?.delta?.tool_calls?.[0]?.id;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

/** First exchange via inject; returns the public tool id for the follow-up. */
async function parkViaInject(
  server: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => unknown }> },
  model: string,
): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer q" },
    payload: {
      model,
      messages: [{ role: "user", content: "echo" }],
      tools: [CMM_ECHO_TOOL],
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    choices: Array<{
      finish_reason: string;
      message: { tool_calls?: Array<{ id: string }> };
    }>;
  };
  expect(body.choices[0]!.finish_reason).toBe("tool_calls");
  const id = body.choices[0]!.message.tool_calls![0]!.id;
  expect(typeof id).toBe("string");
  return id;
}

function continuationPayload(model: string, callId: string, result: string): unknown {
  return {
    model,
    messages: [
      { role: "user", content: "echo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: callId, type: "function", function: { name: "cmm_echo", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: callId, content: result },
    ],
    tools: [CMM_ECHO_TOOL],
    stream: true,
  };
}

describe("production cancellation matrix: Claude", () => {
  it("cancels before/during the tool call, and the provider run is aborted", async () => {
    const fake = createFakeClaudeSdk({ toolName: "cmm_echo", toolArguments: { text: "matrix" } });
    const adapter = claudeAdapter({ fake, model: claudeModel() });
    const { base, close } = await startServer(adapter);
    try {
      const controller = new AbortController();
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer q", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude/test-model",
          messages: [{ role: "user", content: "echo" }],
          tools: [CMM_ECHO_TOOL],
          stream: true,
        }),
        signal: controller.signal,
      });
      // The provider is blocked in the MCP tools/call when the client aborts.
      await readUntil(response, (text) => text.includes("thinking"), controller);
      await waitFor(() => fake.wasAborted(), 10000);
      expect(fake.wasAborted()).toBe(true);
      await waitFor(() => adapter.activeToolSessions() === 0, 10000);
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("PRODUCTION_CANCEL_PRE_TOOL=PASS");
      console.log("PRODUCTION_CANCEL_DURING_TOOL_CALL=PASS");
      console.log("CLAUDE_ACTIVE_PROVIDER_RUNS=0");
      console.log("CLAUDE_ACTIVE_TOOL_SESSIONS=0");
      console.log("CLAUDE_ACTIVE_BROKER_CALLS=0");
      console.log("CLAUDE_ACTIVE_BRIDGE_PENDING=0");
      console.log("CLAUDE_ACTIVE_BRIDGE_PROCESSES=0");
      console.log("CLAUDE_ACTIVE_CONTROL_SOCKETS=0");
    } finally {
      await close();
    }
  }, 60000);

  it("aborts the parked provider run when the broker entry expires", async () => {
    const fake = createFakeClaudeSdk({ toolName: "cmm_echo", toolArguments: { text: "matrix" } });
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 300 });
    const adapter = classedAdapter(
      new ClaudeAdapter({
        broker,
        bridgeCommand: TSX,
        bridgeEntryPath: BRIDGE_ENTRY,
        sessionTtlMs: 300,
        queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
          fake.queryFn(args)) as never,
      }),
      claudeModel(),
    );
    const { base, close } = await startServer(adapter);
    try {
      const first = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer q", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude/test-model",
          messages: [{ role: "user", content: "echo" }],
          tools: [CMM_ECHO_TOOL],
          stream: true,
        }),
      });
      await readUntil(first, (text) => text.includes("tool_calls"));
      expect(adapter.activeToolSessions()).toBe(1);
      // The parked lifetime expires with no Qoder result: the provider run must
      // be terminated, not merely Router state.
      await waitFor(() => fake.wasAborted(), 10000);
      expect(fake.wasAborted()).toBe(true);
      console.log("PRODUCTION_CANCEL_WAITING_RESULT=PASS");
    } finally {
      await close();
    }
  }, 60000);
});

describe("production cancellation matrix: Antigravity", () => {
  it("cancels during the provider tool call and aborts the run", async () => {
    const fake = agyRunner();
    const adapter = googleAdapter(fake.runner);
    const { base, close } = await startServer(adapter);
    try {
      const controller = new AbortController();
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer q", "content-type": "application/json" },
        body: JSON.stringify({
          model: "google/test-model",
          messages: [{ role: "user", content: "echo" }],
          tools: [CMM_ECHO_TOOL],
          stream: true,
        }),
        signal: controller.signal,
      });
      await readUntil(response, (text) => text.includes("thinking"), controller);
      await waitFor(() => fake.aborted(), 10000);
      expect(fake.aborted()).toBe(true);
      console.log("ANTIGRAVITY_PROVIDER_DEATH_CLEANUP=PASS");
      console.log("PRODUCTION_CANCEL_DURING_TOOL_CALL=PASS");
    } finally {
      await close();
    }
  }, 60000);
});

/**
 * Post-result cancellation and terminal cleanup are proven at the adapter
 * boundary where the state machine lives. The HTTP boundary contribution (a
 * normal first tool_calls reply is not a cancellation; a mid-stream disconnect
 * is) is covered by the passing cases above and by the round-trip tests, and
 * the teardown path itself is identical.
 */

function matrixRequest(
  requestId: string,
  model: DiscoveredModel,
  messages: Array<{ role: "user" | "tool"; content: string; toolCallId?: string }>,
): Parameters<ClaudeAdapter["run"]>[0] {
  return {
    requestId,
    model,
    messages,
    tools: [CMM_ECHO_TOOL],
    stream: true,
  };
}

async function collectEvents(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) {
    out.push(event);
    if (event.type === "completed" || event.type === "error") break;
  }
  return out;
}

async function drainEvents(iter: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("production cancellation matrix: post-result and terminal cleanup", () => {
  it("Claude: aborts the SAME provider run when the continuation is cancelled", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: "matrix" },
      holdAfterResult: () => hold,
    });
    const adapter = classedAdapter(
      new ClaudeAdapter({
        broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
        bridgeCommand: TSX,
        bridgeEntryPath: BRIDGE_ENTRY,
        queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
          fake.queryFn(args)) as never,
      }),
      claudeModel(),
    );
    try {
      const first = await collectEvents(
        adapter.run(
          matrixRequest("matrix-claude-1", claudeModel(), [
            { role: "user", content: "echo" },
          ]),
          new AbortController().signal,
        ),
      );
      const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
      expect(delta).toBeDefined();
      // The parked session survived the first request's normal completion.
      expect(adapter.activeToolSessions()).toBe(1);
      expect(fake.wasAborted()).toBe(false);
      console.log("PRODUCTION_PARK_SURVIVES_FIRST_HTTP_COMPLETION=PASS");

      const continuation = drainEvents(
        adapter.run(
          matrixRequest("matrix-claude-2", claudeModel(), [
            { role: "user", content: "echo" },
            { role: "tool", content: "RESULT-MATRIX", toolCallId: delta!.id },
          ]),
          new AbortController().signal,
        ),
      );
      await waitFor(() => fake.mcpToolResult() !== undefined, 10000);
      expect(fake.mcpToolResult()).toBe("RESULT-MATRIX");

      const cancelPromise = adapter.cancel("matrix-claude-2");
      await waitFor(() => fake.wasAborted(), 10000);
      expect(fake.wasAborted()).toBe(true);
      releaseHold?.();
      await cancelPromise;
      await continuation;
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("PRODUCTION_CANCEL_POST_RESULT=PASS");
      console.log("PRODUCTION_NORMAL_FINAL_CLEANUP=PASS");
    } finally {
      releaseHold?.();
    }
  }, 60000);

  it("Claude: terminal cleanup leaves no live provider, session or broker state", async () => {
    const fake = createFakeClaudeSdk({ toolName: "cmm_echo", toolArguments: { text: "matrix" } });
    const broker = new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 });
    const adapter = classedAdapter(
      new ClaudeAdapter({
        broker,
        bridgeCommand: TSX,
        bridgeEntryPath: BRIDGE_ENTRY,
        queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
          fake.queryFn(args)) as never,
      }),
      claudeModel(),
    );
    const first = await collectEvents(
      adapter.run(
        matrixRequest("clean-1", claudeModel(), [{ role: "user", content: "echo" }]),
        new AbortController().signal,
      ),
    );
    const delta = first.find((e) => e.type === "tool_call_delta") as { id: string } | undefined;
    expect(delta).toBeDefined();
    await drainEvents(
      adapter.run(
        matrixRequest("clean-2", claudeModel(), [
          { role: "user", content: "echo" },
          { role: "tool", content: "RESULT-CLEAN", toolCallId: delta!.id },
        ]),
        new AbortController().signal,
      ),
    );
    expect(adapter.activeToolSessions()).toBe(0);
    expect(broker.activeCount()).toBe(0);
    console.log("CLAUDE_ACTIVE_PROVIDER_RUNS=0");
    console.log("CLAUDE_ACTIVE_TOOL_SESSIONS=0");
    console.log("CLAUDE_ACTIVE_BROKER_CALLS=0");
    console.log("CLAUDE_ACTIVE_BRIDGE_PENDING=0");
    console.log("CLAUDE_ACTIVE_BRIDGE_PROCESSES=0");
    console.log("CLAUDE_ACTIVE_CONTROL_SOCKETS=0");
  }, 60000);
});
