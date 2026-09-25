import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Chat Completions / Responses parity for a generic Code Router client.
 *
 * The generic client uses the canonical Code Router bearer and no client
 * metadata header. Both surfaces must make the SAME authorization and model
 * capability decision, and both must deliver a structured (never flattened)
 * tool call that the client can execute and return.
 */

const CMMCHAT_TOKEN = "parity-cmmchat-secret";
const CODE_TOKEN = "parity-code-secret";
const MODEL = "command-code/generic-echo";
const GENERIC_AUTH = { authorization: `Bearer ${CODE_TOKEN}` };
const RESPONSES_TOOL = {
  type: "function",
  name: "cmm_echo",
  description: "Return the supplied text unchanged.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

const STEPS = [
  { kind: "calls" as const, calls: [{ id: "gcall_1", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
  { kind: "final" as const, prefix: "answer=" },
];

async function harness() {
  const registry = new ProviderRegistry();
  const provider = new GenericToolProvider({ provider: "command-code", modelId: MODEL, steps: STEPS });
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

interface ResponsesBody {
  model: string;
  status: string;
  output: Array<Record<string, unknown>>;
}

describe("generic Code Router client — Responses surface", () => {
  it("completes a two-step function-call round trip with exact model identity", async () => {
    const { server } = await harness();

    const first = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: GENERIC_AUTH,
      payload: { model: MODEL, input: "run the echo tool", tools: [RESPONSES_TOOL] },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ResponsesBody;
    expect(firstBody.model).toBe(MODEL);
    const call = firstBody.output.find((item) => item.type === "function_call")!;
    expect(call.call_id).toBe("gcall_1");
    expect(call.name).toBe("cmm_echo");
    expect(call.arguments).toBe('{"text":"alpha"}');
    // Responses distinguishes the output item id from the continuation call id.
    expect(call.id).not.toBe(call.call_id);
    console.log("RESPONSES_GENERIC_FUNCTION_CALL=PASS");

    const result = "CLIENT_EXECUTED_R1";
    const second = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        input: [
          { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
          { type: "function_call_output", call_id: call.call_id, output: result },
        ],
        tools: [RESPONSES_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ResponsesBody;
    expect(secondBody.model).toBe(MODEL);
    const text = secondBody.output
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content as Array<{ text: string }>).map((part) => part.text))
      .join("");
    expect(text).toBe(`answer=[ids=gcall_1][results=${result}]`);
    console.log("RESPONSES_GENERIC_CONTINUATION=PASS");
  });

  it("keeps authorization and capability parity with Chat Completions", async () => {
    const { server } = await harness();

    const denied = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}` },
      payload: { model: MODEL, input: "hi", tools: [RESPONSES_TOOL] },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.type).toBe("unsupported_capability");

    const unknownModel = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: GENERIC_AUTH,
      payload: { model: "command-code/nope", input: "hi", tools: [RESPONSES_TOOL] },
    });
    expect(unknownModel.statusCode).toBe(400);
    expect(unknownModel.json().error.type).toBe("unknown_model");
    console.log("CHAT_RESPONSES_PROFILE_PARITY=PASS");
  });

  it("streams the canonical function-call item lifecycle without flattening", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: GENERIC_AUTH,
      payload: { model: MODEL, input: "run the echo tool", stream: true, tools: [RESPONSES_TOOL] },
    });
    expect(response.statusCode).toBe(200);

    const body = (response as unknown as { body: string }).body;
    const events = parseNamedSse(body);
    const names = events.map((entry) => entry.event);
    expect(names).toContain("response.output_item.added");
    expect(names).toContain("response.function_call_arguments.delta");
    expect(names).toContain("response.function_call_arguments.done");
    expect(names).toContain("response.output_item.done");
    expect(names).toContain("response.completed");

    const added = events.find((entry) => entry.event === "response.output_item.added")!.data;
    const item = added.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.call_id).toBe("gcall_1");
    expect(item.name).toBe("cmm_echo");
    // Structured, never flattened into prose: the item id differs from the
    // continuation call id and both are carried as fields.
    expect(item.id).not.toBe(item.call_id);

    const argsDone = events.find(
      (entry) => entry.event === "response.function_call_arguments.done",
    )!.data;
    expect(argsDone.arguments).toBe('{"text":"alpha"}');
    expect(argsDone.item_id).toBe(item.id);
    console.log("RESPONSES_STRUCTURED_TOOL_STREAM=PASS");
  });
});

function parseNamedSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of body.split("\n\n")) {
    const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
    });
  }
  return events;
}

function parseChatSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join(""),
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("generic Code Router client — Chat Completions streaming", () => {
  it("streams structured tool_call deltas, ids and arguments, then terminates coherently", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "run the echo tool" }],
        tools: [CMM_ECHO_TOOL],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;

    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const frames = parseChatSse(body);
    const deltas = frames.flatMap((frame) => {
      const choices = (frame.choices as Array<{ delta?: { tool_calls?: unknown[] } }>) ?? [];
      return choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
    }) as Array<{ index: number; id: string; type: string; function: { name?: string; arguments?: string } }>;

    expect(deltas.length).toBeGreaterThan(0);
    const call = deltas[0]!;
    expect(call.id).toBe("gcall_1");
    expect(call.type).toBe("function");
    expect(call.function.name).toBe("cmm_echo");
    expect(call.function.arguments).toBe('{"text":"alpha"}');

    const finishes = frames.flatMap(
      (frame) => (frame.choices as Array<{ finish_reason: string | null }>) ?? [],
    );
    expect(finishes.some((choice) => choice.finish_reason === "tool_calls")).toBe(true);
    console.log("GENERIC_STREAMING_TOOL_CALLS=PASS");
  });
});
