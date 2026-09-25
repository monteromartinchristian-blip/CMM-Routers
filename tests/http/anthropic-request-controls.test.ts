import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { protocolCapabilitiesFor } from "../../src/core/protocol-capabilities.js";

/**
 * Findings P5 and P6 — the Anthropic-compatible surface must not accept and
 * ignore semantic request controls, and its wire-auth compatibility must be
 * declared truthfully rather than implied.
 */

const CMMCHAT_TOKEN = "controls-cmmchat-secret";
const CODE_TOKEN = "controls-code-secret";
const MODEL = "command-code/controls-model";

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

function send(
  server: ReturnType<typeof buildServer>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { authorization: `Bearer ${CODE_TOKEN}` },
) {
  return server.inject({
    method: "POST",
    url: "/v1/messages",
    headers,
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], ...payload },
  });
}

describe("Anthropic request controls are truthful", () => {
  it("accepts a valid max_tokens and forwards it", async () => {
    const { server, provider } = await harness();
    const response = await send(server, { max_tokens: 128 });
    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    console.log("ANTHROPIC_MAX_TOKENS_VALIDATED=PASS");
  });

  it("rejects an invalid max_tokens instead of forwarding any number", async () => {
    const { server, provider } = await harness();
    for (const bad of [0, -1, 1.5, "many" as unknown as number]) {
      const response = await send(server, { max_tokens: bad });
      expect(response.statusCode, String(bad)).toBe(400);
      expect((response.json() as { error: { type: string } }).error.type).toBe(
        "invalid_request_error",
      );
    }
    expect(provider.runCount).toBe(0);
  });

  it("explicitly refuses generation controls it cannot represent", async () => {
    const { server, provider } = await harness();
    for (const control of ["temperature", "top_p", "top_k", "stop_sequences"]) {
      const response = await send(server, { max_tokens: 64, [control]: control === "stop_sequences" ? ["x"] : 0.5 });
      expect(response.statusCode, control).toBe(400);
      // The Anthropic taxonomy has no "unsupported" type, so the refusal is an
      // invalid_request_error whose message names the refused control.
      const error = (response.json() as { error: { type: string; message: string } }).error;
      expect(error.type, control).toBe("invalid_request_error");
      expect(error.message, control).toContain(control);
    }
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_UNSUPPORTED_CONTROLS_REFUSED=PASS");
  });

  it("refuses an unknown request control rather than ignoring it", async () => {
    const { server } = await harness();
    const response = await send(server, { max_tokens: 64, bogus_control: true });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      "bogus_control",
    );
  });

  it("declares control truth in the published descriptor", () => {
    const descriptor = protocolCapabilitiesFor("CHAT_AND_TOOLS", "command-code");
    const anthropic = descriptor.protocols.anthropic_messages;
    expect(anthropic.request_controls.max_tokens).toBe("supported");
    for (const control of ["temperature", "top_p", "top_k", "stop_sequences"]) {
      expect(anthropic.request_controls[control], control).toBe("explicit_unsupported");
    }
    console.log("ANTHROPIC_REQUEST_CONTROLS_TRUTHFUL=PASS");
  });
});

describe("Anthropic wire authentication truth", () => {
  it("accepts an API-key-style header mapping to the SAME Code Router profile", async () => {
    const { server, provider } = await harness();
    const response = await send(server, { max_tokens: 64 }, { "x-api-key": CODE_TOKEN });
    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    console.log("ANTHROPIC_ALTERNATE_AUTH_WIRE=PASS");
  });

  it("keeps bearer auth supported", async () => {
    const { server } = await harness();
    const response = await send(server, { max_tokens: 64 });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a wrong API key", async () => {
    const { server, provider } = await harness();
    const response = await send(server, { max_tokens: 64 }, { "x-api-key": "wrong-value" });
    expect(response.statusCode).toBe(401);
    expect(provider.runCount).toBe(0);
  });

  it("fails closed when both authorization wires are present", async () => {
    const { server, provider } = await harness();
    const response = await send(
      server,
      { max_tokens: 64 },
      { authorization: `Bearer ${CODE_TOKEN}`, "x-api-key": CODE_TOKEN },
    );
    expect(response.statusCode).toBe(401);
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_AMBIGUOUS_AUTH_FAILS_CLOSED=PASS");
  });

  it("does not create a third credential role: CMMChat remains CHAT_ONLY", async () => {
    const { server, provider } = await harness();
    const response = await send(
      server,
      { max_tokens: 64, tools: [{ name: "cmm_echo", input_schema: { type: "object" } }] },
      { "x-api-key": CMMCHAT_TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_NO_THIRD_CREDENTIAL_ROLE=PASS");
  });

  it("declares auth truth in the published descriptor", () => {
    const descriptor = protocolCapabilitiesFor("CHAT_AND_TOOLS", "command-code");
    expect(descriptor.protocols.anthropic_messages.auth).toEqual({
      authorization_bearer: true,
      api_key_header: true,
    });
    // OpenAI surfaces accept bearer only; this is surface-specific truth.
    expect(descriptor.protocols.openai_chat.auth.api_key_header).toBe(false);
    console.log("ANTHROPIC_AUTH_WIRE_TRUTHFUL=PASS");
  });
});
