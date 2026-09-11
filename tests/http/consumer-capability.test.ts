import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { effectiveToolCapability, CONSUMER_CMMCHAT, CONSUMER_QODER } from "../../src/core/consumer-capability.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const CMMCHAT_TOKEN = "cmmchat-token";
const QODER_TOKEN = "qoder-token";

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

class ToolCapableProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/capable-model",
        provider: "chatgpt",
        upstreamModel: "capable-model",
        displayName: "Capable",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

describe("consumer capability policy (CMMChat CHAT_ONLY / Qoder CHAT_AND_TOOLS)", () => {
  let registry: ProviderRegistry;
  let provider: ToolCapableProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new ToolCapableProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  function serverWithQoder(): ReturnType<typeof buildServer> {
    return buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry,
    });
  }

  it("pure policy: CMMChat is always CHAT_ONLY even on a capable provider", () => {
    expect(effectiveToolCapability(CONSUMER_CMMCHAT, "CHAT_AND_TOOLS")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_CMMCHAT, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_QODER, "CHAT_AND_TOOLS")).toBe("CHAT_AND_TOOLS");
    expect(effectiveToolCapability(CONSUMER_QODER, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_QODER, undefined)).toBe("CHAT_ONLY");
  });

  it("CMMCHAT_TOOLS_REJECTED: the CMMChat bearer cannot send tools to a CHAT_AND_TOOLS model", async () => {
    const server = serverWithQoder();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(CMMCHAT_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.invocations).toBe(0);
    console.log("CMMCHAT_TOOLS_REJECTED=PASS");
  });

  it("QODER_TOOLS_ALLOWED_WHEN_PROVIDER_CAPABLE: the Qoder bearer may send tools", async () => {
    const server = serverWithQoder();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(QODER_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.invocations).toBe(1);
    console.log("QODER_TOOLS_ALLOWED_WHEN_PROVIDER_CAPABLE=PASS");
  });

  it("Qoder stays CHAT_ONLY on a CHAT_ONLY model (capability truthfulness)", async () => {
    const chatOnlyRegistry = new ProviderRegistry();
    const chatOnlyProvider = new ToolCapableProvider();
    const originalDiscover = chatOnlyProvider.discoverModels.bind(chatOnlyProvider);
    chatOnlyProvider.discoverModels = async () => {
      const models = await originalDiscover();
      return models.map((m) => ({ ...m, capability: "CHAT_ONLY" as const }));
    };
    await chatOnlyRegistry.register(chatOnlyProvider);
    await chatOnlyRegistry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry: chatOnlyRegistry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(QODER_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    console.log("QODER_TOOLS_BLOCKED_ON_CHAT_ONLY_MODEL=PASS");
  });

  it("UNAUTHENTICATED_TOOL_ESCALATION=NONE: no token cannot reach a provider with tools", async () => {
    const server = serverWithQoder();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(provider.invocations).toBe(0);
    console.log("UNAUTHENTICATED_TOOL_ESCALATION=NONE");
  });

  it("CLIENT_CAPABILITY_SPOOFING=NONE: the CMMChat token cannot impersonate Qoder", async () => {
    const server = serverWithQoder();
    // CMMChat token, model capable: still rejected; no header/body claim can
    // upgrade the consumer because identity comes only from the token.
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(CMMCHAT_TOKEN), "x-consumer": "qoder" },
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(provider.invocations).toBe(0);
    console.log("CLIENT_CAPABILITY_SPOOFING=NONE");
  });

  it("server with no Qoder token configured grants no consumer tools", async () => {
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      registry,
    });
    // Even the 'qoder-looking' token value is invalid when not configured.
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(QODER_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(provider.invocations).toBe(0);
    console.log("UNCONFIGURED_QODER_TOKEN_REJECTED=NONE");
  });
});
