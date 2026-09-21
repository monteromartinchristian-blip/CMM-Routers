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
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const CMMCHAT_TOKEN = "cmmchat-profile-secret";
const CODE_TOKEN = "code-router-profile-secret";
const LEGACY_TOKEN = "legacy-qoder-profile-secret";

function auth(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

/** One provider exposing both a capable and a CHAT_ONLY model. */
class CapabilityProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/capable-model",
        provider: "chatgpt",
        upstreamModel: "capable-model",
        displayName: "Capable Model",
        capability: "CHAT_AND_TOOLS",
      },
      {
        id: "chatgpt/chat-only-model",
        provider: "chatgpt",
        upstreamModel: "chat-only-model",
        displayName: "Chat Only Model",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

describe("Code Router profile authorization (Phase 1)", () => {
  let registry: ProviderRegistry;
  let provider: CapabilityProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new CapabilityProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  function server(options: { codeRouterToken?: string; qoderToken?: string } = {}) {
    return buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      ...options,
      registry,
    });
  }

  it("CMMCHAT_TOOLS_REJECTED: the CMMChat bearer is CHAT_ONLY on a capable model", async () => {
    const response = await server({ codeRouterToken: CODE_TOKEN }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CMMCHAT_TOKEN),
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

  it("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS: the canonical Code bearer gets tools on a capable model", async () => {
    const response = await server({ codeRouterToken: CODE_TOKEN }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.invocations).toBe(1);
    console.log("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS");
  });

  it("GENERIC_OPENAI_CODE_ROUTER: a generic non-Qoder Code client gets tools", async () => {
    // No client metadata at all: the profile alone authorizes the capable model.
    const response = await server({ codeRouterToken: CODE_TOKEN }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    console.log("GENERIC_OPENAI_CODE_ROUTER=PASS");
  });

  it("LEGACY_QODER_BEARER_STILL_WORKS: the legacy bearer authenticates the Code profile", async () => {
    const response = await server({ qoderToken: LEGACY_TOKEN }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(LEGACY_TOKEN),
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    console.log("LEGACY_QODER_BEARER_STILL_WORKS=PASS");
  });

  it("both Code bearers configured and distinct: both work", async () => {
    const srv = server({ codeRouterToken: CODE_TOKEN, qoderToken: LEGACY_TOKEN });
    for (const token of [CODE_TOKEN, LEGACY_TOKEN]) {
      const response = await srv.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth(token),
        payload: {
          model: "chatgpt/capable-model",
          messages: [{ role: "user", content: "hi" }],
          tools: [CMM_ECHO_TOOL],
        },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("CHAT_ONLY_PROVIDER_STAYS_CHAT_ONLY: the Code profile cannot promote an incapable model", async () => {
    const response = await server({ codeRouterToken: CODE_TOKEN }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: {
        model: "chatgpt/chat-only-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.invocations).toBe(0);
    console.log("CHAT_ONLY_PROVIDER_STAYS_CHAT_ONLY=PASS");
  });

  it("CLIENT_CAPABILITY_SPOOFING=NONE: arbitrary client metadata cannot elevate CMMChat", async () => {
    const srv = server({ codeRouterToken: CODE_TOKEN, qoderToken: LEGACY_TOKEN });
    for (const client of ["qoder", "hermes", "codex", "codex-client", "generic-openai", "x;y"]) {
      const response = await srv.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...auth(CMMCHAT_TOKEN), "x-cmm-client": client },
        payload: {
          model: "chatgpt/capable-model",
          messages: [{ role: "user", content: "hi" }],
          tools: [CMM_ECHO_TOOL],
        },
      });
      expect(response.statusCode, `client=${client}`).toBe(400);
      expect(response.json().error.type).toBe("unsupported_capability");
    }
    expect(provider.invocations).toBe(0);
    console.log("CLIENT_CAPABILITY_SPOOFING=NONE");
  });

  it("client metadata does not change a Code profile request either", async () => {
    const srv = server({ codeRouterToken: CODE_TOKEN });
    const response = await srv.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth(CODE_TOKEN), "x-cmm-client": "definitely-not-qoder" },
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it("MISSING_CODE_BEARER_FAILS_CLOSED: without a Code bearer nothing obtains tools", async () => {
    const srv = server();
    for (const token of [CODE_TOKEN, LEGACY_TOKEN]) {
      const response = await srv.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth(token),
        payload: {
          model: "chatgpt/capable-model",
          messages: [{ role: "user", content: "hi" }],
          tools: [CMM_ECHO_TOOL],
        },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(provider.invocations).toBe(0);
    console.log("MISSING_CODE_BEARER_FAILS_CLOSED=PASS");
  });

  it("invalid credentials never fall back to CMMChat", async () => {
    const srv = server({ codeRouterToken: CODE_TOKEN });
    const response = await srv.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth("wrong-secret"), "x-cmm-client": "qoder" },
      payload: {
        model: "chatgpt/capable-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(provider.invocations).toBe(0);
    console.log("INVALID_AUTH_DOWNGRADE=NONE");
  });

  it("AMBIGUOUS_AUTH_FAILS_CLOSED: a CMMChat/Code bearer collision refuses to build the server", () => {
    expect(() =>
      buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: CODE_TOKEN,
        codeRouterToken: CODE_TOKEN,
        registry,
      }),
    ).toThrow();
    expect(() =>
      buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: LEGACY_TOKEN,
        qoderToken: LEGACY_TOKEN,
        registry,
      }),
    ).toThrow();
    console.log("AMBIGUOUS_AUTH_FAILS_CLOSED=PASS");
  });

  it("Responses surface parity: same profile decision as Chat Completions", async () => {
    const srv = server({ codeRouterToken: CODE_TOKEN });
    const responsesTool = {
      type: "function",
      name: "cmm_echo",
      description: "Return the supplied text unchanged.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    };

    const denied = await srv.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(CMMCHAT_TOKEN),
      payload: { model: "chatgpt/capable-model", input: "hi", tools: [responsesTool] },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.type).toBe("unsupported_capability");

    const allowed = await srv.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(CODE_TOKEN),
      payload: { model: "chatgpt/capable-model", input: "hi", tools: [responsesTool] },
    });
    expect(allowed.statusCode).toBe(200);
    console.log("CHAT_RESPONSES_PROFILE_PARITY=PASS");
  });
});
