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
import {
  protocolCapabilitiesFor,
  ROUTER_PROTOCOL_SUPPORT,
} from "../../src/core/protocol-capabilities.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Subphase B — capability publication is protocol-centric and truthful.
 *
 * A generic client must be able to learn what the selected route can actually
 * represent without knowing anything about the Router's implementation, and
 * publication must never grant authorization.
 */

const CMMCHAT_TOKEN = "cap-pub-cmmchat-secret";
const CODE_TOKEN = "cap-pub-code-secret";

interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  x_cmm?: {
    code_router?: string;
    protocols?: Record<string, boolean>;
    tools?: {
      function?: boolean;
      namespace?: boolean;
      hosted?: boolean;
      tool_choice?: string;
      parallel_tool_calls?: boolean;
    };
    streaming?: boolean;
    cancellation?: boolean;
    developer_role?: boolean;
  };
}

class CapProvider implements ProviderAdapter {
  readonly id = "command-code" as const;
  invocations = 0;

  constructor(private readonly providerId: "command-code" | "chatgpt" = "command-code") {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.providerId}/capable`,
        provider: this.providerId,
        upstreamModel: "capable",
        displayName: "Capable",
        capability: "CHAT_AND_TOOLS",
      },
      {
        id: `${this.providerId}/chat-only`,
        provider: this.providerId,
        upstreamModel: "chat-only",
        displayName: "Chat Only",
        capability: "CHAT_ONLY",
      },
      {
        id: `${this.providerId}/unverified`,
        provider: this.providerId,
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

async function listModels(providerId: "command-code" | "chatgpt" = "command-code") {
  const registry = new ProviderRegistry();
  const provider = new CapProvider(providerId);
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
  return { data: (response.json() as { data: ModelEntry[] }).data, server, provider };
}

describe("protocol-centric capability publication", () => {
  it("CAPABILITY_PUBLICATION_HARNESS_AGNOSTIC: publishes protocol and tool truth", async () => {
    const { data } = await listModels();
    const capable = data.find((model) => model.id === "command-code/capable")!;
    expect(capable.x_cmm?.protocols?.openai_chat).toBe(true);
    expect(capable.x_cmm?.protocols?.openai_responses).toBe(true);
    expect(capable.x_cmm?.protocols?.anthropic_messages).toBe(true);
    expect(capable.x_cmm?.tools?.function).toBe(true);
    expect(capable.x_cmm?.tools?.namespace).toBe(false);
    expect(capable.x_cmm?.tools?.hosted).toBe(false);
    expect(capable.x_cmm?.streaming).toBe(true);
    expect(capable.x_cmm?.cancellation).toBe(true);
    expect(capable.x_cmm?.developer_role).toBe(true);
    console.log("CAPABILITY_PUBLICATION_HARNESS_AGNOSTIC=PASS");
  });

  it("preserves x_cmm.code_router for compatibility", async () => {
    const { data } = await listModels();
    expect(data.find((model) => model.id === "command-code/capable")?.x_cmm?.code_router).toBe(
      "CHAT_AND_TOOLS",
    );
    expect(data.find((model) => model.id === "command-code/chat-only")?.x_cmm?.code_router).toBe(
      "CHAT_ONLY",
    );
  });

  it("CAPABILITY_PUBLICATION_TRUTHFUL: tool truth follows the model verdict", async () => {
    const { data } = await listModels();
    const chatOnly = data.find((model) => model.id === "command-code/chat-only")!;
    expect(chatOnly.x_cmm?.tools?.function).toBe(false);
    // An unverified model publishes nothing at all.
    expect(data.find((model) => model.id === "command-code/unverified")?.x_cmm).toBeUndefined();
    console.log("CAPABILITY_PUBLICATION_TRUTHFUL=PASS");
  });

  it("publishes provider-specific policy truth instead of overclaiming", async () => {
    const { data } = await listModels("command-code");
    const capable = data.find((model) => model.id === "command-code/capable")!;
    expect(capable.x_cmm?.tools?.tool_choice).toBe("full");
    expect(capable.x_cmm?.tools?.parallel_tool_calls).toBe(true);
    console.log("CAPABILITY_POLICY_TRUTH=PASS");
  });

  it("CAPABILITY_PUBLICATION_NOT_AUTHORIZATION: publishing the truth grants nothing", async () => {
    const { data, server, provider } = await listModels();
    expect(data.find((model) => model.id === "command-code/capable")?.x_cmm?.tools?.function).toBe(
      true,
    );
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

  it("UNKNOWN_CAPABILITY_NOT_PROMOTED: a model with no verdict publishes no tool truth", () => {
    const capabilities = protocolCapabilitiesFor(undefined);
    expect(capabilities.tools.function).toBe(false);
    expect(capabilities.tools.namespace).toBe(false);
    expect(capabilities.tools.hosted).toBe(false);
    console.log("UNKNOWN_CAPABILITY_NOT_PROMOTED=PASS");
  });

  it("the descriptor never names a downstream product", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/core/protocol-capabilities.ts"),
      "utf-8",
    ).toLowerCase();
    for (const brand of ["qoder", "hermes", "codex", "claude", "cline", "roo", "deepseek"]) {
      expect(source, `must not name ${brand}`).not.toContain(brand);
    }
    expect(ROUTER_PROTOCOL_SUPPORT.openai_chat).toBe(true);
  });
});
