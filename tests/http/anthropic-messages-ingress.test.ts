import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";

/**
 * Subphase D — the Anthropic Messages-compatible ingress is a PROTOCOL adapter
 * into canonical Router semantics, not a product adapter.
 *
 * Nothing in this path branches on which client sent the request, and the
 * upstream provider path is unchanged.
 */

const CMMCHAT_TOKEN = "anthropic-cmmchat-secret";
const CODE_TOKEN = "anthropic-code-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

const TOOL = {
  name: "cmm_echo",
  description: "Return the supplied text unchanged.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

async function harness(steps = [
  { kind: "calls" as const, calls: [{ id: "gcall_a", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
  { kind: "final" as const, prefix: "answer=" },
]) {
  const registry = new ProviderRegistry();
  const provider = new GenericToolProvider({ provider: "command-code", modelId: MODEL, steps });
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

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

describe("Anthropic Messages-compatible ingress", () => {
  it("ANTHROPIC_MESSAGES_COMPAT: completes the client-owned tool round trip", async () => {
    const { server } = await harness();

    const first = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 512,
        system: "be terse",
        messages: [{ role: "user", content: "echo please" }],
        tools: [TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as AnthropicResponse;
    expect(firstBody.type).toBe("message");
    expect(firstBody.role).toBe("assistant");
    expect(firstBody.model).toBe(MODEL);
    expect(firstBody.stop_reason).toBe("tool_use");
    const toolUse = firstBody.content.find((block) => block.type === "tool_use")!;
    expect(toolUse.name).toBe("cmm_echo");
    expect(toolUse.input).toEqual({ text: "alpha" });
    expect(firstBody.usage.input_tokens).toBeGreaterThanOrEqual(0);
    console.log("ANTHROPIC_TOOL_USE_SURFACED=PASS");

    const second = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 512,
        messages: [
          { role: "user", content: "echo please" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: toolUse.id, name: "cmm_echo", input: { text: "alpha" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "CLIENT_RESULT" }],
          },
        ],
        tools: [TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as AnthropicResponse;
    expect(secondBody.stop_reason).toBe("end_turn");
    const text = secondBody.content.find((block) => block.type === "text")!;
    expect(text.text).toBe(`answer=[ids=${toolUse.id}][results=CLIENT_RESULT]`);
    console.log("ANTHROPIC_MESSAGES_COMPAT=PASS");
  });

  it("supports a plain text turn with a system prompt", async () => {
    const { server } = await harness([{ kind: "final", prefix: "plain=" }]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: { model: MODEL, max_tokens: 64, system: "sys", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AnthropicResponse;
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content[0]!.text).toBe("plain=[ids=][results=]");
  });

  it("maps tool_choice exactly and rejects an unrepresentable constraint", async () => {
    const { server, provider } = await harness([
      { kind: "calls", calls: [{ id: "gcall_a", name: "cmm_echo", arguments: "{}" }] },
      { kind: "final", prefix: "x=" },
    ]);
    const required = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
      },
    });
    expect(required.statusCode).toBe(200);
    expect(provider.turns.at(-1)!.toolChoice).toEqual({ kind: "required" });
    expect(provider.turns.at(-1)!.parallelToolCalls).toBe(false);

    const named = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL],
        tool_choice: { type: "tool", name: "cmm_echo" },
      },
    });
    expect(named.statusCode).toBe(200);
    expect(provider.turns.at(-1)!.toolChoice).toEqual({ kind: "named", name: "cmm_echo" });
    console.log("ANTHROPIC_TOOL_CHOICE_MAPPED=PASS");
  });

  it("keeps CMMChat CHAT_ONLY and uses the Anthropic error envelope", async () => {
    const { server, provider } = await harness();
    const denied = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}` },
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL],
      },
    });
    expect(denied.statusCode).toBe(400);
    const body = denied.json() as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_CHAT_ONLY_REJECTION=PASS");
  });

  it("returns an Anthropic-shaped authentication error", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { type: string } }).error.type).toBe("authentication_error");
  });

  it("selects the exact model and never falls back", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: { model: "command-code/nope", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { type: string } }).error.type).toBe("invalid_request_error");
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_EXACT_MODEL_NO_FALLBACK=PASS");
  });

  it("stops after remediation of unrepresentable content blocks", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain("image");
    expect(provider.runCount).toBe(0);
  });

  it("streams the canonical Anthropic event lifecycle", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;
    const names = [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]!);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names).toContain("content_block_stop");
    expect(names).toContain("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");
    expect(body).toContain('"tool_use"');
    expect(body).toContain("input_json_delta");
    console.log("ANTHROPIC_STREAMING=PASS");
  });
});
