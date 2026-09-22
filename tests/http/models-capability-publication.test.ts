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

const CMMCHAT_TOKEN = "publication-cmmchat-secret";
const CODE_TOKEN = "publication-code-secret";

interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  x_cmm?: { code_router?: string };
}

class DiscoveryProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "command-code/capable",
        provider: "command-code",
        upstreamModel: "capable",
        displayName: "Capable",
        capability: "CHAT_AND_TOOLS",
      },
      {
        id: "command-code/chat-only",
        provider: "command-code",
        upstreamModel: "chat-only",
        displayName: "Chat Only",
        capability: "CHAT_ONLY",
      },
      {
        // Capability not yet verified: must not be published as either value.
        id: "command-code/unverified",
        provider: "command-code",
        upstreamModel: "unverified",
        displayName: "Unverified",
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

describe("truthful Code Router capability publication on /v1/models", () => {
  let registry: ProviderRegistry;
  let provider: DiscoveryProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new DiscoveryProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  function server() {
    return buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      codeRouterToken: CODE_TOKEN,
      registry,
    });
  }

  async function listModels(token: string): Promise<ModelEntry[]> {
    const response = await server().inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { data: ModelEntry[] }).data;
  }

  it("GENERIC_OPENAI_MODEL_DISCOVERY: a generic Code client can read an exact CHAT_AND_TOOLS model", async () => {
    const data = await listModels(CODE_TOKEN);
    const capable = data.find((m) => m.id === "command-code/capable");
    expect(capable?.x_cmm?.code_router).toBe("CHAT_AND_TOOLS");
    console.log("GENERIC_OPENAI_MODEL_DISCOVERY=PASS");
  });

  it("publishes CHAT_ONLY truthfully", async () => {
    const data = await listModels(CODE_TOKEN);
    const chatOnly = data.find((m) => m.id === "command-code/chat-only");
    expect(chatOnly?.x_cmm?.code_router).toBe("CHAT_ONLY");
  });

  it("omits the extension for a model whose capability is not verified", async () => {
    const data = await listModels(CODE_TOKEN);
    const unverified = data.find((m) => m.id === "command-code/unverified");
    expect(unverified).toBeDefined();
    expect(unverified?.x_cmm).toBeUndefined();
    console.log("MODEL_CAPABILITY_TRUTHFULNESS=PASS");
  });

  it("preserves the existing OpenAI-compatible model shape additively", async () => {
    const data = await listModels(CODE_TOKEN);
    expect(data.map((m) => m.id)).toEqual([
      "command-code/capable",
      "command-code/chat-only",
      "command-code/unverified",
    ]);
    for (const model of data) {
      expect(model.object).toBe("model");
      expect(model.owned_by).toBe("cmm:command-code");
      expect(Object.keys(model).every((k) => ["id", "object", "owned_by", "x_cmm"].includes(k))).toBe(
        true,
      );
    }
  });

  it("publishes the same capability to the CMMChat bearer without granting it tools", async () => {
    // Publication is a fact about the model, not an authorization grant.
    const forCmmchat = await listModels(CMMCHAT_TOKEN);
    expect(forCmmchat.find((m) => m.id === "command-code/capable")?.x_cmm?.code_router).toBe(
      "CHAT_AND_TOOLS",
    );

    const rejected = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}` },
      payload: {
        model: "command-code/capable",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.type).toBe("unsupported_capability");
    expect(provider.invocations).toBe(0);
    console.log("CAPABILITY_PUBLICATION_GRANTS_NOTHING=PASS");
  });

  it("an advertised CHAT_ONLY model still fails closed when tools are requested", async () => {
    const rejected = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CODE_TOKEN}` },
      payload: {
        model: "command-code/chat-only",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.type).toBe("unsupported_capability");
    expect(provider.invocations).toBe(0);
  });
});

describe("model discovery additive compatibility alias", () => {
  it("carries the same entries under both the OpenAI `data` member and `models`", async () => {
    const ownRegistry = new ProviderRegistry();
    await ownRegistry.register(new DiscoveryProvider());
    await ownRegistry.refresh();
    const ownServer = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      codeRouterToken: CODE_TOKEN,
      registry: ownRegistry,
    });
    const response = await ownServer.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${CODE_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { object: string; data: ModelEntry[]; models?: ModelEntry[] };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.models).toEqual(body.data);
    console.log("MODEL_DISCOVERY_ADDITIVE_ALIAS=PASS");
  });
});
