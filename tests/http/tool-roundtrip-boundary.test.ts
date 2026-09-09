import { describe, expect, it } from "vitest";
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

const CMMCHAT_TOKEN = "roundtrip-cmmchat-token";
const QODER_TOKEN = "roundtrip-qoder-token";

class RoundTripProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  lastRequest: RouterRequest | null = null;

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.lastRequest = request;
    const hasToolResult = request.messages.some((m) => m.role === "tool");
    if (!hasToolResult) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "upstream_call_42",
        name: "cmm_echo",
        argumentsDelta: '{"text":"alpha"}',
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "final-answer" };
    yield { type: "completed", finishReason: "stop" };
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/rt-model",
        provider: "chatgpt",
        upstreamModel: "rt-model",
        displayName: "RT",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async cancel(): Promise<void> {}
}

function qoderServer(registry: ProviderRegistry): ReturnType<typeof buildServer> {
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    qoderToken: QODER_TOKEN,
    registry,
  });
}

async function freshServer(): Promise<{
  server: ReturnType<typeof buildServer>;
  provider: RoundTripProvider;
}> {
  const registry = new ProviderRegistry();
  const provider = new RoundTripProvider();
  await registry.register(provider);
  await registry.refresh();
  return { server: qoderServer(registry), provider };
}

describe("OpenAI tool semantics preserved at the Router boundary (Task 13 §2)", () => {
  it("preserves upstream tool call id, name, and arguments to Qoder (chat completions)", async () => {
    const { server } = await freshServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/rt-model",
        messages: [{ role: "user", content: "echo alpha" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    const call = body.choices[0]!.message.tool_calls[0]!;
    // Upstream-supplied ID is not reconstructed heuristically.
    expect(call.id).toBe("upstream_call_42");
    expect(call.function.name).toBe("cmm_echo");
    expect(call.function.arguments).toBe('{"text":"alpha"}');
    console.log("TOOL_CALL_ID_ROUNDTRIP=PASS");
    console.log("TOOL_NAME_ROUNDTRIP=PASS");
    console.log("TOOL_ARGUMENTS_ROUNDTRIP=PASS");
  });

  it("preserves the tool result id back to the provider and continues (tool role)", async () => {
    const { server, provider } = await freshServer();
    const continuation = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/rt-model",
        messages: [
          { role: "user", content: "echo alpha" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "upstream_call_42",
                type: "function",
                function: { name: "cmm_echo", arguments: '{"text":"alpha"}' },
              },
            ],
          },
          { role: "tool", content: "alpha", tool_call_id: "upstream_call_42" },
        ],
      },
    });
    expect(continuation.statusCode).toBe(200);
    const body = continuation.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("final-answer");
    // The internal request carries the assistant tool-call history intact.
    const toolMsg = provider.lastRequest!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("upstream_call_42");
    const asst = provider.lastRequest!.messages.find((m) => m.role === "assistant");
    expect(asst?.toolCalls?.[0]?.id).toBe("upstream_call_42");
    console.log("TOOL_RESULT_ROUNDTRIP=PASS");
  });

  it("preserves assistant tool-call history through the Responses surface", async () => {
    const { server, provider } = await freshServer();
    const continuation = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "chatgpt/rt-model",
        input: [
          { role: "user", content: [{ type: "input_text", text: "echo alpha" }] },
          {
            role: "assistant",
            content: [
              {
                type: "function_call",
                call_id: "resp_call_7",
                name: "cmm_echo",
                arguments: '{"text":"alpha"}',
              },
            ],
          },
          { role: "tool", tool_call_id: "resp_call_7", content: "alpha" },
        ],
      },
    });
    expect(continuation.statusCode).toBe(200);
    const asst = provider.lastRequest!.messages.find((m) => m.role === "assistant");
    expect(asst?.toolCalls?.[0]).toMatchObject({ id: "resp_call_7", function: { name: "cmm_echo" } });
    console.log("RESPONSES_TOOL_HISTORY_PRESERVED=PASS");
  });
});
