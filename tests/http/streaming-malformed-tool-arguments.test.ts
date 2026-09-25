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

/**
 * Finding F1 — the OpenAI streaming surfaces must not surface malformed provider
 * tool arguments. Non-streaming paths validated; the streaming paths forwarded
 * fragments before any validation existed.
 *
 * Tool-call arguments are now buffered until the call completes and are only
 * emitted once they are known to be usable JSON.
 */

const CMMCHAT_TOKEN = "stream-malformed-cmmchat-secret";
const CODE_TOKEN = "stream-malformed-code-secret";
const MODEL = "command-code/stream-args-model";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };
const MALFORMED = ['{"text":', '"alpha"']; // fragments that never form valid JSON
const VALID = ['{"text":', '"alpha"}'];

class FragmentProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  invocations = 0;

  constructor(private readonly fragments: string[]) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "command-code",
        upstreamModel: "stream-args-model",
        displayName: "Stream Args Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    for (const fragment of this.fragments) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "gcall_stream",
        name: "cmm_echo",
        argumentsDelta: fragment,
      };
    }
    yield { type: "completed", finishReason: "tool_calls" };
  }

  async cancel(): Promise<void> {}
}

async function harness(fragments: string[]) {
  const registry = new ProviderRegistry();
  const provider = new FragmentProvider(fragments);
  await registry.register(provider);
  await registry.refresh();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });
  return { server, provider };
}

async function chatStream(server: ReturnType<typeof buildServer>) {
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
    },
  });
}

async function responsesStream(server: ReturnType<typeof buildServer>) {
  return server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: AUTH,
    payload: { model: MODEL, input: "hi", tools: [CMM_ECHO_TOOL], stream: true },
  });
}

describe("OpenAI streaming surfaces fail closed on malformed tool arguments", () => {
  it("CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED", async () => {
    const { server } = await harness(MALFORMED);
    const response = await chatStream(server);
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;

    // A protocol-shaped error is emitted...
    expect(body).toContain("provider_protocol_error");
    // ...and no executable tool call is ever completed.
    expect(body).not.toContain('"arguments":"{\\"text\\":"');
    expect(body).not.toContain('"finish_reason":"tool_calls"');
    console.log("CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED");
  });

  it("RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED", async () => {
    const { server } = await harness(MALFORMED);
    const response = await responsesStream(server);
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;

    expect(body).toContain("response.failed");
    expect(body).toContain("provider_protocol_error");
    expect(body).not.toContain("response.output_item.done");
    expect(body).not.toContain("response.completed");
    console.log("RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED");
  });

  it("MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS", async () => {
    for (const surface of ["chat", "responses"] as const) {
      const { server, provider } = await harness(MALFORMED);
      const body =
        surface === "chat"
          ? (await chatStream(server) as unknown as { body: string }).body
          : (await responsesStream(server) as unknown as { body: string }).body;
      // The provider ran, so this is a real relay path, not a pre-emptive reject.
      expect(provider.invocations).toBe(1);
      // The malformed fragment must not appear in any tool-call payload.
      expect(body, surface).not.toContain('\\"alpha\\"');
      expect(body, surface).toMatch(/provider_protocol_error/);
    }
    console.log("MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS");
  });

  it("VALID_STREAM_TOOL_ARGUMENTS_PRESERVED=PASS", async () => {
    const chat = await harness(VALID);
    const chatBody = (await chatStream(chat.server) as unknown as { body: string }).body;
    expect(chatBody).toContain("gcall_stream");
    expect(chatBody).toContain("cmm_echo");
    expect(chatBody).toContain('\\"alpha\\"');
    expect(chatBody).toContain('"finish_reason":"tool_calls"');

    const responses = await harness(VALID);
    const responsesBody = (await responsesStream(responses.server) as unknown as { body: string })
      .body;
    expect(responsesBody).toContain("response.output_item.done");
    expect(responsesBody).toContain("response.completed");
    expect(responsesBody).toContain('"text\\":\\"alpha\\"');
    console.log("VALID_STREAM_TOOL_ARGUMENTS_PRESERVED=PASS");
  });
});
