import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { createFakeClaudeSdk } from "../helpers/fake-claude-sdk.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");

const CMMCHAT_TOKEN = "cancel-cmmchat-secret";
const CODE_TOKEN = "cancel-code-secret";
const MODEL = "command-code/generic-echo";
const GENERIC_AUTH = { authorization: `Bearer ${CODE_TOKEN}`, "x-cmm-client": "generic-openai" };

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * Stalls while holding a structured tool call open, so a real client socket
 * destroy can be observed as a cancellation rather than a normal completion.
 */
class HangingGenericToolProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  entered = false;
  sawAbort = false;
  cancelled: string[] = [];

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "command-code",
        upstreamModel: "generic-echo",
        displayName: "Generic Tool Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.entered = true;
    const onAbort = (): void => {
      this.sawAbort = true;
    };
    if (signal.aborted) this.sawAbort = true;
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "gcall_hang",
        name: "cmm_echo",
        argumentsDelta: '{"text":"hang"}',
      };
      // Never completes on its own: the request stays open until cancelled.
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // One event after the abort makes the cancellation observable to the
      // Router's usage bookkeeping (it checks the signal per iteration).
      yield { type: "completed", finishReason: "stop" };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

describe("generic Code Router client — cancellation", () => {
  it(
    "abort propagates, pending state is cleaned, and no success is recorded",
    { timeout: 30000 },
    async () => {
      const registry = new ProviderRegistry();
      const provider = new HangingGenericToolProvider();
      await registry.register(provider);
      await registry.refresh();
      const usageStore = new UsageStore();
      const server = buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: CMMCHAT_TOKEN,
        codeRouterToken: CODE_TOKEN,
        registry,
        usageStore,
      });
      await server.listen({ host: "127.0.0.1", port: 0 });
      const address = server.server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      try {
        const chunks: string[] = [];
        let firstChunkSeen!: () => void;
        const firstChunk = new Promise<void>((resolve) => {
          firstChunkSeen = resolve;
        });
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { ...GENERIC_AUTH, "Content-Type": "application/json" },
          },
          (res) => {
            res.on("data", (chunk: Buffer) => {
              chunks.push(chunk.toString("utf-8"));
              firstChunkSeen();
            });
            res.on("error", () => undefined);
          },
        );
        req.on("error", () => undefined);
        req.write(
          JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: "hang" }],
            tools: [CMM_ECHO_TOOL],
            stream: true,
          }),
        );
        req.end();

        await firstChunk;
        expect(chunks.join("")).toContain("gcall_hang");
        expect(usageStore.aggregates().activeRequests).toBe(1);
        await waitFor(() => provider.entered);
        req.destroy();

        // The SERVER must propagate cancellation on its own.
        await waitFor(() => provider.sawAbort && provider.cancelled.length > 0);
        console.log("GENERIC_CANCEL_ABORT_PROPAGATED=PASS");

        await waitFor(() => usageStore.aggregates().activeRequests === 0);
        const aggregates = usageStore.aggregates();
        expect(aggregates.activeRequests).toBe(0);
        expect(aggregates.successCount).toBe(0);
        expect(aggregates.cancelledEvents).toBeGreaterThan(0);
        console.log("CANCELLATION_CLEANS_PENDING_STATE=PASS");
      } finally {
        await server.close();
      }
    },
  );
});

class DiscoveryStubClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/generic-broker-model",
        provider: "claude",
        upstreamModel: "generic-broker-model",
        displayName: "Generic Broker Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
}

describe("generic Code Router client — broker-bound continuation after expiry", () => {
  it(
    "a tool result cannot resume a session whose pending state was released",
    { timeout: 60000 },
    async () => {
      const ARG = "CMM_GENERIC_ARG_5c1f";
      const fake = createFakeClaudeSdk({
        toolName: "cmm_echo",
        toolArguments: { text: ARG },
        finalPrefix: "answer=",
      });
      const adapter = new DiscoveryStubClaudeAdapter({
        broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
        bridgeCommand: TSX,
        bridgeEntryPath: BRIDGE_ENTRY,
        sessionTtlMs: 250,
        queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
          fake.queryFn(args)) as never,
      });
      const registry = new ProviderRegistry();
      await registry.register(adapter);
      await registry.refresh();
      const server = buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: CMMCHAT_TOKEN,
        codeRouterToken: CODE_TOKEN,
        registry,
      });

      try {
        // Exchange 1 parks a Router-owned correlation and surfaces the call.
        const first = await server.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: GENERIC_AUTH,
          payload: {
            model: "claude/generic-broker-model",
            messages: [{ role: "user", content: "echo" }],
            tools: [CMM_ECHO_TOOL],
          },
        });
        expect(first.statusCode).toBe(200);
        const body = first.json() as {
          choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ id: string }> } }>;
        };
        expect(body.choices[0]!.finish_reason).toBe("tool_calls");
        const callId = body.choices[0]!.message.tool_calls![0]!.id;
        expect(callId.startsWith("cmm_claude_")).toBe(true);
        expect(adapter.activeToolSessions()).toBe(1);

        // The parked session is released (TTL) without any client result.
        await waitFor(() => adapter.activeToolSessions() === 0);
        console.log("GENERIC_BROKER_PENDING_RELEASED=PASS");

        // A late result must fail closed rather than resume or restart a run.
        const late = await server.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: GENERIC_AUTH,
          payload: {
            model: "claude/generic-broker-model",
            messages: [
              { role: "user", content: "echo" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: callId, type: "function", function: { name: "cmm_echo", arguments: `{"text":"${ARG}"}` } },
                ],
              },
              { role: "tool", tool_call_id: callId, content: "LATE_RESULT" },
            ],
            tools: [CMM_ECHO_TOOL],
          },
        });
        expect(late.statusCode).toBeGreaterThanOrEqual(400);
        expect(late.json().error.type).toBe("provider_protocol_error");
        expect(fake.mcpToolResult()).toBeUndefined();
        console.log("LATE_TOOL_RESULT_CANNOT_RESUME=PASS");
      } finally {
        await server.close();
      }
    },
  );
});
