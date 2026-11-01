import { describe, expect, it } from "vitest";
import { Duplex } from "node:stream";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import {
  AntigravityAdapter,
  type InferenceRunner,
} from "../../src/providers/antigravity/adapter.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import type {
  DiscoveredModel,
  ProviderId,
  RouterRequest,
} from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Direct adapter invocation without an authenticated profile.
 *
 * The HTTP surfaces always set `RouterRequest.profile` after
 * `resolveToolAccess`; these tests exercise the ADAPTER boundary itself so a
 * future direct caller can never resurrect the audited fail-open
 * `profile ?? "AGENT"` behaviour:
 *
 *   MISSING_PROFILE_WITH_TOOLS        → REJECTED
 *   MISSING_PROFILE_WITH_TOOL_RESULT  → REJECTED
 *   MISSING_PROFILE_WITHOUT_TOOLS     → COMPATIBLE (no broker entry, no AGENT)
 */

const SENTINEL = "MISSING_PROFILE_TEST_SENTINEL";

function baseRequest(provider: ProviderId, overrides: Partial<RouterRequest> = {}): RouterRequest {
  const model: DiscoveredModel = {
    id: `${provider}/fail-closed-model`,
    provider,
    upstreamModel: "fail-closed-model",
    displayName: "Fail Closed",
    capability: "CHAT_AND_TOOLS",
  };
  return {
    requestId: `mp-${provider}`,
    model,
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
    ...overrides,
  };
}

async function outcome(
  iter: AsyncIterable<RouterEvent>,
): Promise<{ events: RouterEvent[]; thrown?: unknown }> {
  const events: RouterEvent[] = [];
  try {
    for await (const event of iter) {
      events.push(event as RouterEvent);
    }
  } catch (error) {
    return { events, thrown: error };
  }
  return { events };
}

/** The missing-profile rejection, and proof the provider path never ran. */
function expectMissingProfileRejection(result: { events: RouterEvent[]; thrown?: unknown }): void {
  const code =
    result.thrown !== undefined
      ? (result.thrown as { code?: string }).code
      : (result.events.find((event) => event.type === "error") as
          | { error: { code: string; message: string } }
          | undefined)?.error.code;
  expect(code).toBe("invalid_request");
  const message =
    result.thrown !== undefined
      ? String((result.thrown as Error).message ?? result.thrown)
      : (result.events
          .map((event) => (event as { error?: { message?: string } }).error)
          .filter(Boolean)
          .map((error) => error!.message)
          .join(" ") || "");
  expect(message).toContain("authenticated router profile");
  expect(message).not.toContain(SENTINEL);
}

// ---------------------------------------------------------------------------
// Codex: scripted app-server transport. A tool-bearing request must be
// rejected BEFORE any transport wire frame; the compatible case completes
// without a profile and without any broker entry.
// ---------------------------------------------------------------------------

function codexTextOnlyTransport(): {
  adapter: CodexAdapter;
  completed: Promise<void>;
} {
  let complete!: (value: void) => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const transport = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as {
        method?: string;
        params?: Record<string, unknown>;
        id?: unknown;
      };
      const respond = (result: unknown): void => {
        transport.push(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
      };
      if (msg.method === "initialize") respond({});
      else if (msg.method === "thread/start") respond({ thread: { id: "thread-1" } });
      else if (msg.method === "thread/inject_items") respond({});
      else if (msg.method === "turn/start") {
        respond({ turn: { id: "turn-1", status: "inProgress", items: [] } });
        setTimeout(() => {
          transport.push(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: { delta: "plain-compatible", itemId: "i", threadId: "thread-1", turnId: "turn-1" },
            })}\n`,
          );
          transport.push(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "completed", items: [] },
              },
            })}\n`,
          );
          complete();
        }, 10);
      } else {
        respond({});
      }
      callback();
    },
  });
  const adapter = new CodexAdapter({
    transportFactory: () => transport,
    broker: new DeferredToolBroker(),
  });
  return { adapter, completed };
}

// ---------------------------------------------------------------------------
// Antigravity: runner double that reports a clean terminal event.
// ---------------------------------------------------------------------------

function agyCompatibleRunner(): { runner: InferenceRunner; reached: () => boolean } {
  let reached = false;
  const runner: InferenceRunner = {
    async runInference(): Promise<never> {
      throw new Error(SENTINEL);
    },
    async streamInference(_args, options, onEvent) {
      reached = true;
      options.onSpawn?.(424242);
      onEvent({ kind: "completed", finishReason: "stop" });
      return { status: 0, signal: null, stdout: "plain-compatible", stderr: "" };
    },
  };
  return { runner, reached: () => reached };
}

// ---------------------------------------------------------------------------

describe("direct adapter runs without a profile fail closed on tool semantics", () => {
  it("codex rejects tool declarations before any transport traffic", async () => {
    const adapter = new CodexAdapter({
      // A transport that can only report "reached": the rejection must not
      // even initialize the app-server.
      transportFactory: () => {
        throw new Error(SENTINEL);
      },
      broker: new DeferredToolBroker(),
    });
    const result = await outcome(
      adapter.run(
        baseRequest("chatgpt", { tools: [CMM_ECHO_TOOL] }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOLS=REJECTED codex");
  });

  it("codex rejects a tool-result continuation before any transport traffic", async () => {
    const adapter = new CodexAdapter({
      transportFactory: () => {
        throw new Error(SENTINEL);
      },
      broker: new DeferredToolBroker(),
    });
    const result = await outcome(
      adapter.run(
        baseRequest("chatgpt", {
          messages: [
            { role: "user", content: "hi" },
            { role: "tool", content: "result", toolCallId: "call-1" },
          ],
        }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOL_RESULT=REJECTED codex");
  });

  it("codex completes a tool-free run without a profile and without assuming AGENT", async () => {
    const { adapter, completed } = codexTextOnlyTransport();
    const result = await outcome(
      adapter.run(baseRequest("chatgpt"), new AbortController().signal),
    );
    expect(result.thrown).toBeUndefined();
    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(result.events.find((event) => event.type === "completed")).toBeDefined();
    expect(
      result.events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event as { text: string }).text)
        .join(""),
    ).toContain("plain-compatible");
    await completed;
    console.log("MISSING_PROFILE_WITHOUT_TOOLS=COMPATIBLE codex");
  });

  it("claude rejects tool declarations before any SDK query", async () => {
    const adapter = new ClaudeAdapter({
      queryFn: (() => {
        throw new Error(SENTINEL);
      }) as never,
    });
    const result = await outcome(
      adapter.run(
        baseRequest("claude", { tools: [CMM_ECHO_TOOL] }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOLS=REJECTED claude");
  });

  it("claude rejects a tool-result continuation before any SDK query", async () => {
    const adapter = new ClaudeAdapter({
      queryFn: (() => {
        throw new Error(SENTINEL);
      }) as never,
    });
    const result = await outcome(
      adapter.run(
        baseRequest("claude", {
          messages: [
            { role: "user", content: "hi" },
            { role: "tool", content: "result", toolCallId: "call-1" },
          ],
        }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOL_RESULT=REJECTED claude");
  });

  it("claude completes a tool-free run without a profile and without assuming AGENT", async () => {
    const adapter = new ClaudeAdapter({
      queryFn: (async function* () {
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "plain" } },
        };
        yield {
          type: "result",
          subtype: "success",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }) as never,
    });
    const result = await outcome(
      adapter.run(baseRequest("claude"), new AbortController().signal),
    );
    expect(result.thrown).toBeUndefined();
    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(
      result.events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event as { text: string }).text)
        .join(""),
    ).toContain("plain");
    expect(result.events.find((event) => event.type === "completed")).toMatchObject({
      finishReason: "stop",
    });
    console.log("MISSING_PROFILE_WITHOUT_TOOLS=COMPATIBLE claude");
  });

  it("antigravity rejects tool declarations before the runner", async () => {
    const { runner } = agyCompatibleRunner();
    // streamInference would be reached only if the guard failed open; make the
    // sentinel loud so a fail-open regression cannot look like a rejection.
    const sentinelRunner: InferenceRunner = {
      async runInference(): Promise<never> {
        throw new Error(SENTINEL);
      },
      streamInference: () => {
        throw new Error(SENTINEL);
      },
    };
    const adapter = new AntigravityAdapter(sentinelRunner, runner as never, {
      broker: new DeferredToolBroker(),
    });
    const result = await outcome(
      adapter.run(
        baseRequest("google", { tools: [CMM_ECHO_TOOL] }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOLS=REJECTED antigravity");
  });

  it("antigravity rejects a tool-result continuation before the runner", async () => {
    const { runner } = agyCompatibleRunner();
    const sentinelRunner: InferenceRunner = {
      async runInference(): Promise<never> {
        throw new Error(SENTINEL);
      },
      streamInference: () => {
        throw new Error(SENTINEL);
      },
    };
    const adapter = new AntigravityAdapter(sentinelRunner, runner as never, {
      broker: new DeferredToolBroker(),
    });
    const result = await outcome(
      adapter.run(
        baseRequest("google", {
          messages: [
            { role: "user", content: "hi" },
            { role: "tool", content: "result", toolCallId: "call-1" },
          ],
        }),
        new AbortController().signal,
      ),
    );
    expectMissingProfileRejection(result);
    console.log("MISSING_PROFILE_WITH_TOOL_RESULT=REJECTED antigravity");
  });

  it("antigravity completes a tool-free run without a profile and without assuming AGENT", async () => {
    const { runner, reached } = agyCompatibleRunner();
    const adapter = new AntigravityAdapter(runner, runner as never, {
      broker: new DeferredToolBroker(),
    });
    const result = await outcome(
      adapter.run(baseRequest("google"), new AbortController().signal),
    );
    expect(result.thrown).toBeUndefined();
    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(reached()).toBe(true);
    expect(result.events.find((event) => event.type === "completed")).toMatchObject({
      finishReason: "stop",
    });
    console.log("MISSING_PROFILE_WITHOUT_TOOLS=COMPATIBLE antigravity");
  });
});
