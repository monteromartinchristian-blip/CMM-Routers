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

const CMMCHAT_TOKEN = "responses-additional-tools-chat-token";
const CODE_TOKEN = "responses-additional-tools-code-token";
const MODEL = "command-code/additional-tools-test";

function fnTool(name: string) {
  return {
    type: "function",
    name,
    description: "test function",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };
}

class CapturingProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  runCount = 0;
  lastRequest: RouterRequest | null = null;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "command-code",
        upstreamModel: "additional-tools-test",
        displayName: "Additional Tools Test",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async cancel(_requestId: string): Promise<void> {
    // Test double has no long-lived provider work to cancel.
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
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });

  return { server, provider };
}

const CODE_AUTH = {
  authorization: `Bearer ${CODE_TOKEN}`,
  "x-cmm-client": "codex-client",
};

describe("Responses additional_tools normalization", () => {
  it("extracts Codex additional_tools and removes the metadata item from messages", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: CODE_AUTH,
      payload: {
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [fnTool("cmm_echo")],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    expect(provider.lastRequest).not.toBeNull();
    expect(provider.lastRequest!.tools).toHaveLength(1);
    expect(provider.lastRequest!.tools[0]!.function.name).toBe("cmm_echo");
    expect(provider.lastRequest!.messages).toEqual([{ role: "user", content: "hi" }]);
    console.log("RESPONSES_ADDITIONAL_TOOLS_EXTRACTED=PASS");
    console.log("RESPONSES_ADDITIONAL_TOOLS_NOT_A_MESSAGE=PASS");
  });

  it("rejects malformed additional_tools role before provider execution", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: CODE_AUTH,
      payload: {
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "user",
            tools: [fnTool("cmm_echo")],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request");
    expect(provider.runCount).toBe(0);
    console.log("RESPONSES_ADDITIONAL_TOOLS_ROLE_VALIDATED=PASS");
  });

  it("fails closed for unsupported tool kinds carried inside additional_tools", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: CODE_AUTH,
      payload: {
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "web_search" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.runCount).toBe(0);
    console.log("RESPONSES_ADDITIONAL_TOOLS_UNSUPPORTED_KIND_REFUSED=PASS");
  });

  it("does not let a CHAT_ONLY bearer hide tools inside additional_tools", async () => {
    const { server, provider } = await harness();

    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: `Bearer ${CMMCHAT_TOKEN}`,
        "x-cmm-client": "codex-client",
      },
      payload: {
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [fnTool("cmm_echo")],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      },
    });

    expect(response.statusCode).not.toBe(200);
    expect(response.json().error).toBeDefined();
    expect(provider.runCount).toBe(0);
    console.log("RESPONSES_ADDITIONAL_TOOLS_CHAT_ONLY_BYPASS=BLOCKED");
  });
});
