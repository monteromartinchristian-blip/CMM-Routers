import { describe, expect, it } from "vitest";
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

/**
 * Finding P4 — capability truth must be scoped per downstream protocol.
 *
 * The previous descriptor mixed protocol availability with global feature flags,
 * so it could not express real differences (Anthropic carries system
 * instructions in a dedicated field and has no developer role) and made
 * `anthropic_messages: true` look broader than the implemented subset.
 */

const CMMCHAT_TOKEN = "scoped-cmmchat-secret";
const CODE_TOKEN = "scoped-code-secret";

interface Surface {
  available?: boolean;
  streaming?: boolean;
  cancellation?: boolean;
  developer_role?: boolean;
  system_field?: boolean;
  tools?: {
    function?: boolean;
    namespace?: boolean;
    hosted?: boolean;
    parallel_tool_calls?: boolean;
    tool_choice?: string;
  };
  auth?: { authorization_bearer?: boolean; api_key_header?: boolean };
  request_controls?: Record<string, string>;
}

interface Entry {
  id: string;
  x_cmm?: {
    code_router?: string;
    canonical_tools?: { function?: boolean; namespace?: boolean; hosted?: boolean };
    protocols?: Record<string, Surface>;
  };
}

class CapProvider implements ProviderAdapter {
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

async function listModels() {
  const registry = new ProviderRegistry();
  const provider = new CapProvider();
  await registry.register(provider);
  await registry.refresh();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });
  const response = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: `Bearer ${CODE_TOKEN}` },
  });
  expect(response.statusCode).toBe(200);
  return { data: (response.json() as { data: Entry[] }).data, server, provider };
}

describe("protocol-scoped capability publication", () => {
  it("CAPABILITY_PUBLICATION_PROTOCOL_SCOPED: every surface carries its own truth", async () => {
    const { data } = await listModels();
    const capable = data.find((m) => m.id === "command-code/capable")!;
    const protocols = capable.x_cmm!.protocols!;

    for (const surface of ["openai_chat", "openai_responses", "anthropic_messages"]) {
      expect(protocols[surface]?.available, surface).toBe(true);
      expect(protocols[surface]?.streaming, surface).toBe(true);
      expect(protocols[surface]?.cancellation, surface).toBe(true);
      expect(protocols[surface]?.tools?.function, surface).toBe(true);
      expect(protocols[surface]?.tools?.namespace, surface).toBe(false);
      expect(protocols[surface]?.tools?.hosted, surface).toBe(false);
    }

    // Real surface differences are expressible rather than flattened.
    expect(protocols.openai_chat?.developer_role).toBe(true);
    expect(protocols.openai_responses?.developer_role).toBe(true);
    expect(protocols.anthropic_messages?.developer_role).toBe(false);
    expect(protocols.anthropic_messages?.system_field).toBe(true);
    console.log("CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=PASS");
  });

  it("publishes protocol-independent canonical algebra truth separately", async () => {
    const { data } = await listModels();
    const canonical = data.find((m) => m.id === "command-code/capable")!.x_cmm!.canonical_tools!;
    expect(canonical.function).toBe(true);
    expect(canonical.namespace).toBe(false);
    expect(canonical.hosted).toBe(false);
  });

  it("preserves x_cmm.code_router for compatibility", async () => {
    const { data } = await listModels();
    expect(data.find((m) => m.id === "command-code/capable")!.x_cmm!.code_router).toBe(
      "CHAT_AND_TOOLS",
    );
  });

  it("CAPABILITY_PUBLICATION_TRUTHFUL: tool truth follows the model verdict per surface", async () => {
    const { data } = await listModels();
    const chatOnly = data.find((m) => m.id === "command-code/chat-only")!;
    for (const surface of ["openai_chat", "openai_responses", "anthropic_messages"]) {
      expect(chatOnly.x_cmm!.protocols![surface]?.tools?.function, surface).toBe(false);
    }
    console.log("CAPABILITY_PUBLICATION_TRUTHFUL=PASS");
  });

  it("UNKNOWN_CAPABILITY_NOT_PROMOTED: no verdict publishes nothing", async () => {
    const { data } = await listModels();
    expect(data.find((m) => m.id === "command-code/unverified")!.x_cmm).toBeUndefined();
    console.log("UNKNOWN_CAPABILITY_NOT_PROMOTED=PASS");
  });

  it("CAPABILITY_PUBLICATION_NOT_AUTHORIZATION: publication still grants nothing", async () => {
    const { server, provider } = await listModels();
    const denied = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}` },
      payload: {
        model: "command-code/capable",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(provider.invocations).toBe(0);
    console.log("CAPABILITY_PUBLICATION_NOT_AUTHORIZATION=PASS");
  });
});
