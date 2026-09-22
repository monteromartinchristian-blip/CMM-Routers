import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { protocolCapabilitiesFor } from "../../src/core/protocol-capabilities.js";

/**
 * Finding F3 — `x_cmm.request_controls` must match runtime behavior.
 *
 * The two OpenAI surfaces were published with one shared descriptor: Chat
 * implements `max_tokens`, Responses implements `max_output_tokens`, and neither
 * rejected `temperature`, which the descriptor claimed was explicitly
 * unsupported. Truth and behavior must come from the same source.
 */

const CMMCHAT_TOKEN = "controls-openai-cmmchat-secret";
const CODE_TOKEN = "controls-openai-code-secret";
const MODEL = "command-code/controls-model";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

async function harness() {
  const registry = new ProviderRegistry();
  const provider = new GenericToolProvider({
    provider: "command-code",
    modelId: MODEL,
    steps: [{ kind: "final", prefix: "done=" }],
  });
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

function chat(server: ReturnType<typeof buildServer>, extra: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], ...extra },
  });
}

function responses(server: ReturnType<typeof buildServer>, extra: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: AUTH,
    payload: { model: MODEL, input: "hi", ...extra },
  });
}

describe("OpenAI surfaces are truthful about request controls", () => {
  it("OPENAI_CHAT_REQUEST_CONTROL_TRUTH: max_tokens is supported and forwarded", async () => {
    const { server, provider } = await harness();
    const response = await chat(server, { max_tokens: 7 });
    expect(response.statusCode).toBe(200);
    expect(provider.turns[0]!.maxOutputTokens).toBe(7);
    console.log("OPENAI_CHAT_REQUEST_CONTROL_TRUTH=PASS");
  });

  it("OPENAI_RESPONSES_MAX_OUTPUT_TOKENS_TRUTH: Responses uses max_output_tokens", async () => {
    const { server, provider } = await harness();
    const response = await responses(server, { max_output_tokens: 9 });
    expect(response.statusCode).toBe(200);
    expect(provider.turns[0]!.maxOutputTokens).toBe(9);
    console.log("OPENAI_RESPONSES_MAX_OUTPUT_TOKENS_TRUTH=PASS");
  });

  it("OPENAI_RESPONSES_REQUEST_CONTROL_TRUTH: the Chat name is refused with a hint", async () => {
    const { server, provider } = await harness();
    const response = await responses(server, { max_tokens: 9 });
    expect(response.statusCode).toBe(400);
    const message = (response.json() as { error: { message: string } }).error.message;
    expect(message).toContain("max_tokens");
    expect(message).toContain("max_output_tokens");
    expect(provider.runCount).toBe(0);
    console.log("OPENAI_RESPONSES_REQUEST_CONTROL_TRUTH=PASS");
  });

  it("OPENAI_TEMPERATURE_NOT_SILENTLY_IGNORED: both surfaces refuse it by name", async () => {
    const { server, provider } = await harness();
    for (const response of [
      await chat(server, { temperature: 0.5 }),
      await responses(server, { temperature: 0.5 }),
    ]) {
      expect(response.statusCode).toBe(400);
      const error = (response.json() as { error: { message: string } }).error;
      expect(error.message).toContain("temperature");
    }
    expect(provider.runCount).toBe(0);
    console.log("OPENAI_TEMPERATURE_NOT_SILENTLY_IGNORED=PASS");
  });

  it("refuses the other unrepresentable generation controls", async () => {
    const { server, provider } = await harness();
    for (const control of ["top_p", "top_k", "stop", "presence_penalty", "frequency_penalty"]) {
      const response = await chat(server, { [control]: 1 });
      expect(response.statusCode, control).toBe(400);
      expect((response.json() as { error: { message: string } }).error.message, control).toContain(
        control,
      );
    }
    expect(provider.runCount).toBe(0);
  });

  it("CAPABILITY_PUBLICATION_TRUTHFUL: every advertised state matches the enforced list", () => {
    const descriptor = protocolCapabilitiesFor("CHAT_AND_TOOLS", "command-code");
    const chatControls = descriptor.protocols.openai_chat.request_controls;
    const responsesControls = descriptor.protocols.openai_responses.request_controls;

    // Per-surface truth, not one shared descriptor.
    expect(chatControls.max_tokens).toBe("supported");
    expect(chatControls.max_output_tokens).toBeUndefined();
    expect(responsesControls.max_output_tokens).toBe("supported");
    expect(responsesControls.max_tokens).toBe("explicit_unsupported");

    // Everything advertised as refused is refused, on both surfaces.
    for (const surface of [chatControls, responsesControls]) {
      expect(surface.temperature).toBe("explicit_unsupported");
      expect(surface.top_p).toBe("explicit_unsupported");
      expect(surface.top_k).toBe("explicit_unsupported");
    }
    console.log("CAPABILITY_PUBLICATION_TRUTHFUL=PASS");
  });

  it("keeps x_cmm.code_router backward compatible", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: AUTH,
    });
    const data = (response.json() as { data: Array<{ id: string; x_cmm?: { code_router?: string } }> })
      .data;
    expect(data.find((model) => model.id === MODEL)?.x_cmm?.code_router).toBe("CHAT_AND_TOOLS");
  });
});
