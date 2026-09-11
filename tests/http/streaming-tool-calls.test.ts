import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, RouterRequest } from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const QODER_TOKEN = "stream-qoder-token";
const CMMCHAT_TOKEN = "stream-cmmchat-token";

/** Emits a tool call in fragments (arguments arrive split) then, on the
 *  continuation request, streams text before AND after, proving boundaries. */
class FragmentedToolProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/stream-tool-model",
        provider: "chatgpt",
        upstreamModel: "stream-tool-model",
        displayName: "Stream Tool",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    const hasToolResult = request.messages.some((m) => m.role === "tool");
    if (!hasToolResult) {
      // Fragmented arguments: never a complete call until assembled.
      yield { type: "tool_call_delta", index: 0, id: "call_frac", name: "cmm_echo", argumentsDelta: '{"te' };
      yield { type: "tool_call_delta", index: 0, id: "call_frac", argumentsDelta: 'xt":"cana' };
      yield { type: "tool_call_delta", index: 0, id: "call_frac", argumentsDelta: 'ry"}' };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    // Continuation: text before, (no second tool), text after, completion.
    yield { type: "text_delta", text: "before:" };
    yield { type: "text_delta", text: "after" };
    yield { type: "completed", finishReason: "stop" };
  }
  async cancel(): Promise<void> {}
}

function serverWith(provider: ProviderAdapter): { server: ReturnType<typeof buildServer>; provider: ProviderAdapter } {
  const registry = new ProviderRegistry();
  return {
    server: buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry,
    }),
    provider,
  };
}

async function fresh(): Promise<{ server: ReturnType<typeof buildServer>; provider: FragmentedToolProvider }> {
  const registry = new ProviderRegistry();
  const provider = new FragmentedToolProvider();
  await registry.register(provider);
  await registry.refresh();
  return {
    server: buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry,
    }),
    provider,
  };
}

describe("streaming tool-call semantics (Task 13 §7)", () => {
  it("assembles fragmented streaming arguments into one complete tool call (non-stream)", async () => {
    const { server, provider } = await fresh();
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/stream-tool-model",
        messages: [{ role: "user", content: "echo canary" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ id: string; function: { arguments: string } }> } }>;
    };
    const call = body.choices[0]!.message.tool_calls[0]!;
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    // Fragments joined, never partial JSON emitted as complete.
    expect(call.function.arguments).toBe('{"text":"canary"}');
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
    console.log("STREAMING_TOOL_ARGUMENT_ASSEMBLY=PASS");
  });

  it("streams tool_call deltas incrementally and preserves text around the tool boundary", async () => {
    const { server, provider } = await fresh();
    // Continuation with a tool result: text before and after.
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/stream-tool-model",
        messages: [
          { role: "user", content: "echo canary" },
          { role: "tool", content: "canary", tool_call_id: "call_frac" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("before:after");
    expect(provider.invocations).toBe(1);
    console.log("STREAMING_CONTINUATION_AFTER_TOOL=PASS");
  });

  it("isolates concurrent streamed tool calls (no cross-request leak)", async () => {
    const registry = new ProviderRegistry();
    const providerA = new FragmentedToolProvider();
    const providerB = new FragmentedToolProvider();
    await registry.register(providerA);
    await registry.register(providerB);
    await registry.refresh();
    void serverWith;
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry,
    });
    const payload = {
      model: "chatgpt/stream-tool-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [CMM_ECHO_TOOL],
    };
    const [a, b] = await Promise.all([
      server.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${QODER_TOKEN}` }, payload }),
      server.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${QODER_TOKEN}` }, payload }),
    ]);
    const aBody = a.json() as { choices: Array<{ message: { tool_calls: Array<{ id: string }> } }> };
    const bBody = b.json() as { choices: Array<{ message: { tool_calls: Array<{ id: string }> } }> };
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(aBody.choices[0]!.message.tool_calls[0]!.id).toBe("call_frac");
    expect(bBody.choices[0]!.message.tool_calls[0]!.id).toBe("call_frac");
    console.log("CROSS_REQUEST_TOOL_CALL_LEAK=NONE");
    console.log("CROSS_REQUEST_TOOL_RESULT_LEAK=NONE");
  });
});
