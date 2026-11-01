import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { RouterError, type RouterErrorCode } from "../../src/core/errors.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * P1 on the Anthropic Messages surface.
 *
 * The combined tree carries three Claude-capable protocol surfaces (Chat
 * Completions, Responses, Anthropic Messages). P1 must not grow a second
 * classifier: the Claude adapter classifies an SDK failure once into the
 * canonical RouterError code, and every surface translates that same code into
 * its own error taxonomy. This file proves the Anthropic translation and the
 * `is_error` precedence end to end, in streaming and non-streaming form.
 */

const BEARER = "anthropic-p1-secret";
const MODEL = "claude/test-model";
const AUTH = { authorization: `Bearer ${BEARER}` };

/** The transport is not under test here: only discovery needs a stub. */
class DiscoveryStubClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "claude",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
}

class ScriptedClaudeProvider implements ProviderAdapter {
  readonly id = "claude" as const;

  constructor(private readonly events: RouterEvent[]) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "claude",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    for (const event of this.events) yield event;
  }

  async cancel(): Promise<void> {}
}

async function harness(provider: ProviderAdapter) {
  const registry = new ProviderRegistry();
  await registry.register(provider);
  await registry.refresh();
  return buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
}

/** Build the real adapter over a scripted SDK stream. */
async function sdkHarness(messages: readonly unknown[]) {
  const adapter = new DiscoveryStubClaudeAdapter({
    queryFn: (() => ({
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close() {},
    })) as never,
    profileDir: "/tmp/cmm-router-test-profile",
  });
  return { server: await harness(adapter) };
}

function anthropicBody(stream = false): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "hola" }],
    ...(stream ? { stream: true } : {}),
  };
}

interface AnthropicErrorPayload {
  type: string;
  error: { type: string; message: string };
}

const matrix: Array<[RouterErrorCode, number, string]> = [
  ["provider_auth_required", 401, "authentication_error"],
  ["provider_permission_denied", 403, "permission_error"],
  ["provider_quota_exhausted", 429, "rate_limit_error"],
  ["provider_rate_limited", 429, "rate_limit_error"],
  ["provider_unavailable", 503, "overloaded_error"],
  ["provider_timeout", 504, "api_error"],
  ["provider_protocol_error", 500, "api_error"],
];

describe("Anthropic Messages — one classifier, one status per canonical code", () => {
  for (const [code, status, type] of matrix) {
    it(`anthropic messages maps ${code} to ${status}`, async () => {
      const server = await harness(
        new ScriptedClaudeProvider([{ type: "error", error: new RouterError(code, "provider failure") }]),
      );
      const response = await server.inject({
        method: "POST",
        url: "/v1/messages",
        headers: AUTH,
        payload: anthropicBody(),
      });
      expect(response.statusCode).toBe(status);
      const body = response.json() as AnthropicErrorPayload;
      expect(body.type).toBe("error");
      expect(body.error.type).toBe(type);
      await server.close();
    });
  }

  it("ANTHROPIC_NEVER_200_ON_REAL_ERROR: a failed provider run is not an empty 200", async () => {
    const server = await harness(
      new ScriptedClaudeProvider([
        { type: "error", error: new RouterError("provider_auth_required", "provider failure") },
      ]),
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).not.toBe(200);
    expect(response.statusCode).toBe(401);
    expect((response.json() as AnthropicErrorPayload).error.type).toBe("authentication_error");
    console.log("ANTHROPIC_REAL_ERROR_IS_NOT_HTTP_200=PASS");
    await server.close();
  });

  it("streaming emits an in-band error event and no successful message_stop", async () => {
    const server = await harness(
      new ScriptedClaudeProvider([
        { type: "text_delta", text: "partial" },
        { type: "error", error: new RouterError("provider_auth_required", "provider failure") },
      ]),
    );
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(true),
    });
    // Headers are already on the wire, so the taxonomy moves in-band.
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("authentication_error");
    expect(response.body).not.toContain("message_stop");
    expect(response.body).not.toContain('"stop_reason":"end_turn"');
    console.log("ANTHROPIC_STREAMING_ERROR_IN_BAND=PASS");
    await server.close();
  });
});

describe("Anthropic Messages — SDK is_error precedence", () => {
  it("SDK_IS_ERROR_TRUE_IS_AN_ERROR: success subtype with is_error returns 401, not empty 200", async () => {
    const { server } = await sdkHarness([
      { type: "result", subtype: "success", is_error: true, result: "OAuth token expired" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as AnthropicErrorPayload;
    expect(body.error.type).toBe("authentication_error");
    console.log("ANTHROPIC_IS_ERROR_TRUE_BEATS_SUCCESS_SUBTYPE=PASS");
    await server.close();
  });

  it("ANTHROPIC_AUTH_ERROR_REDACTED: an auth failure never echoes provider text", async () => {
    const CANARY = "sk-CANARY42AB";
    const { server } = await sdkHarness([
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: `API Error: 401 Unauthorized — Authorization: Bearer ${CANARY}`,
      },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as AnthropicErrorPayload;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(serialized).not.toContain("sk-CANARY");
    expect(body.error.message).toBe("Provider authentication required");
    console.log("ANTHROPIC_AUTH_ERROR_HAS_NO_PROVIDER_TEXT=PASS");
    await server.close();
  });

  it("a 403 from the SDK is a permission failure, not an auth failure", async () => {
    const { server } = await sdkHarness([
      { type: "result", subtype: "success", is_error: true, result: "403 permission denied for this model" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as AnthropicErrorPayload).error.type).toBe("permission_error");
    await server.close();
  });

  it("streaming is_error result fails in-band with the same taxonomy", async () => {
    const { server } = await sdkHarness([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
      { type: "result", subtype: "success", is_error: true, result: "Your session has expired" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(true),
    });
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("authentication_error");
    expect(response.body).not.toContain("message_stop");
    console.log("ANTHROPIC_STREAMING_IS_ERROR_IN_BAND=PASS");
    await server.close();
  });

  it("an unknown terminal subtype fails closed instead of completing", async () => {
    const { server } = await sdkHarness([
      { type: "result", subtype: "something_new", is_error: false, result: "?" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(500);
    expect((response.json() as AnthropicErrorPayload).error.type).toBe("api_error");
    await server.close();
  });

  it("a genuine answer that mentions authentication is still a 200", async () => {
    const { server } = await sdkHarness([
      { type: "assistant", message: { content: [{ type: "text", text: "the authentication guide is ready" }] } },
      { type: "result", subtype: "success", is_error: false, result: "the authentication guide is ready" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { content: Array<{ type: string; text?: string }> };
    expect(body.content[0]?.text).toContain("authentication guide");
    console.log("ANTHROPIC_MODEL_TEXT_NEVER_BECOMES_AN_ERROR=PASS");
    await server.close();
  });

  it("REDACTION_ON_FAIL_CLOSED_PATH: unknown provider text never reaches the client", async () => {
    const CANARY = "sk-PROTO42AB";
    const { server } = await sdkHarness([
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: `unexpected handshake failure Authorization: Bearer ${CANARY} cookie: session=${CANARY}`,
      },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: anthropicBody(),
    });
    expect(response.statusCode).toBe(500);
    const serialized = JSON.stringify(response.json());
    // Two independent layers: the adapter redacts the provider text, and the
    // Anthropic surface publishes a generic fail-closed message instead of it.
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).toContain("Provider error");
    console.log("ANTHROPIC_FAIL_CLOSED_TEXT_REDACTED=PASS");
    await server.close();
  });

  it("REDACTION_AT_ADAPTER_BOUNDARY: the classified message itself carries no credential", async () => {
    const CANARY = "sk-ADAPTER42AB";
    const adapter = new DiscoveryStubClaudeAdapter({
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            is_error: true,
            result: `unexpected handshake failure Authorization: Bearer ${CANARY} cookie: session=${CANARY}`,
          };
        },
        close() {},
      })) as never,
      profileDir: "/tmp/cmm-router-test-profile",
    });
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(
      {
        requestId: "anthropic-redaction",
        profile: "AGENT",
        model: {
          id: MODEL,
          provider: "claude",
          upstreamModel: "test-model",
          displayName: "Test Model",
          capability: "CHAT_AND_TOOLS",
        },
        messages: [{ role: "user", content: "hola" }],
        tools: [],
        stream: true,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    const failure = events.find((event) => event.type === "error") as { error?: unknown } | undefined;
    expect(failure?.error).toBeInstanceOf(RouterError);
    const message = (failure?.error as RouterError).message;
    expect((failure?.error as RouterError).code).toBe("provider_protocol_error");
    expect(message).not.toContain(CANARY);
    expect(message).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(message).toContain("[redacted]");
    console.log("ADAPTER_ERROR_MESSAGE_REDACTED=PASS");
  });
});
