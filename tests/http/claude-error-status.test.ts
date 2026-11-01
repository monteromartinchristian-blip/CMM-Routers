import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { RouterError, type RouterErrorCode } from "../../src/core/errors.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * P1 contract at the HTTP boundary: a provider failure must keep its status
 * code on both non-streaming surfaces, and a legitimate model answer must stay
 * a 200. Streaming cannot change the status after headers are sent, so the
 * failure travels as the protocol's in-band error and never as a success
 * completion.
 */

const BEARER = "claude-error-status-token";

class ScriptedClaudeProvider implements ProviderAdapter {
  readonly id = "claude" as const;
  invocations = 0;

  constructor(private readonly events: RouterEvent[]) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/claude-haiku-4-5",
        provider: "claude",
        upstreamModel: "claude-haiku-4-5",
        displayName: "Haiku 4.5",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    for (const event of this.events) yield event;
  }

  async cancel(): Promise<void> {}
}

async function harness(events: RouterEvent[]): Promise<{
  server: ReturnType<typeof buildServer>;
  provider: ScriptedClaudeProvider;
}> {
  const registry = new ProviderRegistry();
  const provider = new ScriptedClaudeProvider(events);
  await registry.register(provider);
  await registry.refresh();
  const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
  return { server, provider };
}

const auth = { authorization: `Bearer ${BEARER}` };

function failure(code: RouterErrorCode): RouterEvent {
  return { type: "error", error: new RouterError(code, "provider failure") };
}

const errorCases: Array<[RouterErrorCode, number]> = [
  ["provider_auth_required", 401],
  ["provider_permission_denied", 403],
  ["provider_quota_exhausted", 429],
  ["provider_rate_limited", 429],
  ["provider_timeout", 504],
  ["provider_unavailable", 503],
  ["provider_protocol_error", 500],
];

describe("provider failures keep their HTTP status", () => {
  for (const [code, status] of errorCases) {
    it(`chat/completions maps ${code} to ${status}`, async () => {
      const { server } = await harness([failure(code)]);
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: {
          model: "claude/claude-haiku-4-5",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.type).toBe(code);
      await server.close();
    });

    it(`responses maps ${code} to ${status}`, async () => {
      const { server } = await harness([failure(code)]);
      const response = await server.inject({
        method: "POST",
        url: "/v1/responses",
        headers: auth,
        payload: { model: "claude/claude-haiku-4-5", input: "hi" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.type).toBe(code);
      await server.close();
    });
  }

  it("a genuine model answer stays a 200 with its content", async () => {
    const { server } = await harness([
      { type: "text_delta", text: "hola" },
      { type: "completed", finishReason: "stop" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "claude/claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("hola");
    console.log("GENUINE_ANSWER_IS_200=PASS");
    await server.close();
  });

  it("a model answer that mentions auth is not turned into an error", async () => {
    const { server } = await harness([
      { type: "text_delta", text: "the authentication guide is ready" },
      { type: "completed", finishReason: "stop" },
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "claude/claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toContain("authentication guide");
    console.log("MODEL_TEXT_NEVER_BECOMES_AN_ERROR=PASS");
    await server.close();
  });

  it("streaming signals the failure in-band and never as a success completion", async () => {
    const { server } = await harness([
      { type: "text_delta", text: "partial" },
      failure("provider_auth_required"),
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "claude/claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });
    // Headers were already sent, so the status cannot change; the stream must
    // carry an explicit error and must not emit a successful finish chunk.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("provider_auth_required");
    expect(response.body).not.toContain('"finish_reason":"stop"');
    console.log("STREAMING_ERROR_IN_BAND=PASS");
    await server.close();
  });

  it("responses streaming emits response.failed, not response.completed", async () => {
    const { server } = await harness([
      { type: "text_delta", text: "partial" },
      failure("provider_auth_required"),
    ]);
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth,
      payload: {
        model: "claude/claude-haiku-4-5",
        input: "hi",
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("response.failed");
    expect(response.body).not.toContain("response.completed");
    console.log("RESPONSES_STREAMING_FAILED_EVENT=PASS");
    await server.close();
  });
});
