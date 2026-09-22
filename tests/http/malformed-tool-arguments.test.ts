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
 * Finding P1 — malformed provider tool arguments must never become executable.
 *
 * A provider that emits unparseable tool arguments must not have those arguments
 * silently replaced with `{}` (or surfaced as a usable call). The Router fails
 * closed with a protocol-shaped error instead.
 */

const CMMCHAT_TOKEN = "malformed-cmmchat-secret";
const CODE_TOKEN = "malformed-code-secret";
const MODEL = "command-code/args-model";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };
const MALFORMED = '{"text":'; // truncated JSON
const VALID = '{"text":"ok"}';

class ArgsProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  invocations = 0;

  constructor(private readonly args: string) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "command-code",
        upstreamModel: "args-model",
        displayName: "Args Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    yield { type: "tool_call_delta", index: 0, id: "gcall_bad", name: "cmm_echo", argumentsDelta: this.args };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  async cancel(): Promise<void> {}
}

async function harness(args: string) {
  const registry = new ProviderRegistry();
  const provider = new ArgsProvider(args);
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

const tools = [CMM_ECHO_TOOL];

describe("malformed tool arguments fail closed", () => {
  it("MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED on /v1/chat/completions", async () => {
    const { server } = await harness(MALFORMED);
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], tools },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const body = response.json() as { error?: { type?: string; message?: string }; choices?: unknown };
    expect(body.error?.type).toBe("provider_protocol_error");
    // NO_ARGUMENT_FABRICATION: never a usable tool call carrying `{}`.
    expect(body.choices).toBeUndefined();
    console.log("MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED");
  });

  it("MALFORMED_TOOL_ARGUMENTS_NOT_EXECUTABLE on /v1/responses", async () => {
    const { server } = await harness(MALFORMED);
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: { model: MODEL, input: "hi", tools },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const body = response.json() as { error?: { type?: string }; output?: unknown };
    expect(body.error?.type).toBe("provider_protocol_error");
    expect(body.output).toBeUndefined();
    console.log("MALFORMED_TOOL_ARGUMENTS_NOT_EXECUTABLE=PASS");
  });

  it("NO_ARGUMENT_FABRICATION on /v1/messages (non-streaming)", async () => {
    const { server } = await harness(MALFORMED);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "cmm_echo", input_schema: { type: "object" } }],
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const body = response.json() as { type?: string; error?: { type?: string }; content?: unknown };
    expect(body.type).toBe("error");
    expect(body.error?.type).toBe("api_error");
    // No fabricated tool_use block is ever emitted.
    expect(body.content).toBeUndefined();
    console.log("NO_ARGUMENT_FABRICATION=PASS");
  });

  it("malformed arguments never become a usable tool_use while streaming", async () => {
    const { server } = await harness(MALFORMED);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "cmm_echo", input_schema: { type: "object" } }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;
    expect(body).toContain("event: error");
    // The tool block must never be opened with fabricated input.
    expect(body).not.toContain('"type":"tool_use"');
    expect(body).not.toContain('"stop_reason":"tool_use"');
    console.log("STREAMING_MALFORMED_TOOL_ARGUMENTS_FAIL_CLOSED=PASS");
  });

  it("valid structured arguments are still preserved exactly", async () => {
    const { server } = await harness(VALID);
    const chat = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], tools },
    });
    expect(chat.statusCode).toBe(200);
    const chatBody = chat.json() as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { arguments: string } }> } }>;
    };
    expect(chatBody.choices[0]!.message.tool_calls![0]!.function.arguments).toBe(VALID);

    const anthropic = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "cmm_echo", input_schema: { type: "object" } }],
      },
    });
    expect(anthropic.statusCode).toBe(200);
    const body = anthropic.json() as { content: Array<Record<string, unknown>> };
    const toolUse = body.content.find((block) => block.type === "tool_use")!;
    expect(toolUse.input).toEqual({ text: "ok" });
    console.log("VALID_TOOL_ARGUMENTS_PRESERVED=PASS");
  });
});
