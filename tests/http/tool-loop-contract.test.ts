import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const BEARER = "tool-loop-test-secret";

/**
 * Scripted provider that emits a tool call, then — when the tool result is
 * supplied back as a follow-up request — emits the final answer. Proves the
 * ROUTER contract for an externally-owned tool loop without any live quota:
 * Qoder owns execution; the router only relays tool requests and results.
 */
class ToolLoopScriptedProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/tool-loop-model",
        provider: "chatgpt",
        upstreamModel: "tool-loop-model",
        displayName: "Tool Loop Model",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    const hasToolResult = request.messages.some((m) => m.role === "tool");
    if (!hasToolResult) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-1",
        name: "cmm_echo",
        argumentsDelta: '{"text":"canary"}',
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const result = request.messages.filter((m) => m.role === "tool").map((m) => m.content).join("");
    yield { type: "text_delta", text: `final:${result}` };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

describe("externally-owned tool round-trip contract (mocked, no live quota)", () => {
  let server: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ToolLoopScriptedProvider());
    await registry.refresh();
    server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
  });

  it("relays a tool request, accepts the Qoder-executed result, and completes", async () => {
    const auth = { authorization: `Bearer ${BEARER}` };
    // Turn 1: model requests a tool call.
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "chatgpt/tool-loop-model",
        messages: [{ role: "user", content: "echo canary" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const call = firstBody.choices[0]!.message.tool_calls[0]!;
    expect(call.function.name).toBe("cmm_echo");

    // Qoder executes the tool locally (simulated here — the router never
    // executes anything itself) and supplies the result back.
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "chatgpt/tool-loop-model",
        messages: [
          { role: "user", content: "echo canary" },
          { role: "tool", content: "canary", tool_call_id: call.id },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      choices: Array<{ finish_reason: string; message: { content: string } }>;
    };
    expect(secondBody.choices[0]!.finish_reason).toBe("stop");
    expect(secondBody.choices[0]!.message.content).toContain("canary");
    console.log("TOOL_LOOP_CONTRACT=PASS");
  });

  it("provider routes stay honestly CHAT_ONLY until a live round-trip is proven", async () => {
    // Technical feasibility (this pass, no live quota burned):
    // - Chat/Responses relay tool CALLS (deltas + tool_calls shape) and
    //   accept tool RESULTS (role=tool messages) — contract proven above.
    // - No live provider has demonstrated emitting a real tool call under
    //   a forcing prompt (live suites report CHAT_ONLY_NO_TOOL_EMITTED and
    //   are skipped without CMM_RUN_LIVE=1).
    // - Claude runs with provider-native tools disallowed by design; the
    //   external loop is the only permitted path and is unproven live.
    // Therefore the original DoD is NOT_MET and capabilities stay CHAT_ONLY.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [
      "src/providers/codex/adapter.ts",
      "src/providers/claude/adapter.ts",
      "src/providers/antigravity/adapter.ts",
      "src/providers/command-code/adapter.ts",
    ]) {
      const source = readFileSync(join(import.meta.dirname, "../../", file), "utf-8");
      expect(source, file).toContain('"CHAT_ONLY"');
    }
    console.log("TASK_13_ORIGINAL_DOD=NOT_MET");
    console.log("TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY");
  });
});
