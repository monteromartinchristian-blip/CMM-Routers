import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

const CHAT_TOKEN = "responses-instructions-chat-token";
const CODE_TOKEN = "responses-instructions-code-token";
const MODEL = "command-code/responses-instructions-test";

class CapturingProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  runCount = 0;
  lastRequest: RouterRequest | null = null;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "command-code",
        upstreamModel: "responses-instructions-test",
        displayName: "Responses Instructions Test",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async cancel(_requestId: string): Promise<void> {
    // No long-lived work in this test double.
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.runCount += 1;
    this.lastRequest = request;
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }
}

async function harness() {
  const provider = new CapturingProvider();
  const registry = new ProviderRegistry();
  await registry.register(provider);
  await registry.refresh();

  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });

  return { server, provider };
}

const AUTH = {
  authorization: `Bearer ${CODE_TOKEN}`,
  "x-cmm-client": "codex-client",
};

describe("Responses top-level instructions normalization", () => {
  it("prepends top-level instructions as the first system message byte-exact", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        instructions: "TOP LEVEL\nINSTRUCTIONS",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "INPUT DEVELOPER" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    expect(provider.lastRequest?.messages).toEqual([
      { role: "system", content: "TOP LEVEL\nINSTRUCTIONS" },
      { role: "system", content: "INPUT DEVELOPER" },
      { role: "user", content: "hello" },
    ]);
    console.log("RESPONSES_TOP_LEVEL_INSTRUCTIONS_PRESERVED=PASS");
    console.log("RESPONSES_TOP_LEVEL_INSTRUCTIONS_ORDER=PASS");
  });

  it("preserves an empty instructions string instead of silently changing the wire value", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        instructions: "",
        input: "hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    expect(provider.lastRequest?.messages).toEqual([
      { role: "system", content: "" },
      { role: "user", content: "hello" },
    ]);
    console.log("RESPONSES_EMPTY_INSTRUCTIONS_PRESERVED=PASS");
  });

  it("treats null instructions as absent", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        instructions: null,
        input: "hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    expect(provider.lastRequest?.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    console.log("RESPONSES_NULL_INSTRUCTIONS_ABSENT=PASS");
  });

  it("rejects non-string non-null instructions before provider execution", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        instructions: { unexpected: true },
        input: "hello",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        type: "invalid_request",
        message: "instructions must be a string or null",
      },
    });
    expect(provider.runCount).toBe(0);
    console.log("RESPONSES_INVALID_INSTRUCTIONS_REJECTED=PASS");
  });
});
