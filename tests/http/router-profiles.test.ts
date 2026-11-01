import { describe, expect, it } from "vitest";
import { buildServer, type ServerOptions } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  DiscoveredModel,
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { RouterError } from "../../src/core/errors.js";
import {
  DeferredToolBroker,
  createPublicToolCallId,
} from "../../src/core/deferred-tool-broker.js";
import type { RouterFunctionTool } from "../../src/core/model.js";
import { testScopedActionRegistry } from "../fixtures/scoped-actions.js";

const CHAT_TOKEN = "profile-chat-token";
const CODE_TOKEN = "profile-code-router-token";
const QODER_TOKEN = "profile-legacy-qoder-token";

const MODEL = "chatgpt/profile-tools-model";

function scopedTool(name: string): RouterFunctionTool {
  return {
    kind: "function",
    type: "function",
    function: {
      name,
      description: "caller supplied description",
      parameters: {
        type: "object",
        properties: { evil: { type: "string" } },
        additionalProperties: true,
      },
    },
  };
}

function arbitraryTool(name = "run_command"): RouterFunctionTool {
  return {
    kind: "function",
    type: "function",
    function: {
      name,
      description: "harness-supplied tool",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };
}

/**
 * One provider + one broker serving BOTH profiles. It parks the call in the
 * shared DeferredToolBroker and claims it on the continuation, exactly like the
 * production adapters do; only the tool name differs (CHAT is scoped).
 */
class BrokerBackedProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  readonly seen: RouterRequest[] = [];
  readonly broker: DeferredToolBroker;

  constructor(broker: DeferredToolBroker) {
    this.broker = broker;
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: MODEL,
        provider: "chatgpt",
        upstreamModel: "profile-tools-model",
        displayName: "Profile Tools",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.seen.push(request);
    const result = request.messages.find(
      (message) => message.role === "tool" && typeof message.toolCallId === "string",
    );
    if (result) {
      const claim = this.broker.claimByPublicToolCallId<{ args: string }>(
        result.toolCallId as string,
        request.profile,
      );
      if (claim.outcome !== "resolved" || !claim.context) {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            "profile test provider found no parked call",
          ),
        };
        return;
      }
      yield { type: "text_delta", text: `echo:${claim.context.args}` };
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    const tool = request.tools[0];
    if (tool === undefined) {
      yield { type: "text_delta", text: "plain chat" };
      yield { type: "completed", finishReason: "stop" };
      return;
    }

    const publicId = createPublicToolCallId("chatgpt");
    this.broker.createPendingCall(
      {
        profile: request.profile ?? "AGENT",
        provider: "chatgpt",
        sessionId: request.requestId,
        toolCallId: publicId,
        publicToolCallId: publicId,
      },
      undefined,
      signal,
      { args: '{"text":"canary"}' },
    );
    yield {
      type: "tool_call_delta",
      index: 0,
      id: publicId,
      name: tool.function.name,
      argumentsDelta: '{"text":"canary"}',
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  async cancel(): Promise<void> {}
}

class HangingProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  readonly cancelled: string[] = [];
  entered = false;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/hanging-model",
        provider: "chatgpt",
        upstreamModel: "hanging-model",
        displayName: "Hanging",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.entered = true;
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (signal.aborted) return;
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

interface Harness {
  server: ReturnType<typeof buildServer>;
  provider: BrokerBackedProvider;
  broker: DeferredToolBroker;
}

async function harness(overrides: Partial<ServerOptions> = {}): Promise<Harness> {
  const registry = new ProviderRegistry();
  const broker = new DeferredToolBroker();
  const provider = new BrokerBackedProvider(broker);
  await registry.register(provider);
  await registry.refresh();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    qoderToken: QODER_TOKEN,
    scopedActions: testScopedActionRegistry(),
    registry,
    ...overrides,
  });
  return { server, provider, broker };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function chatPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

function chatToolCall(body: unknown): {
  id: string;
  name: string;
  arguments: string;
} {
  const parsed = body as {
    choices: Array<{
      finish_reason: string;
      message: {
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const choice = parsed.choices[0]!;
  const call = choice.message.tool_calls?.[0];
  if (!call) throw new Error("expected a tool call");
  return {
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

function chatContent(body: unknown): string {
  const parsed = body as { choices: Array<{ message: { content: string | null } }> };
  return parsed.choices[0]!.message.content ?? "";
}

function responsesText(body: unknown): string {
  const parsed = body as {
    output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  return parsed.output
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
}

function sseText(body: string): string {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as {
      choices?: Array<{ delta?: { content?: string } }>;
    })
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("");
}

function continuationMessages(call: { id: string; name: string; arguments: string }): unknown[] {
  return [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    },
    { role: "tool", content: "canary", tool_call_id: call.id },
  ];
}

describe("Router profiles: CHAT", () => {
  it("ordinary CHAT conversation works without tools", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(chatContent(response.json())).toBe("plain chat");
    console.log("CHAT_PROFILE=PASS");
    console.log("CHAT_DEFAULT_TOOL_ACCESS=NONE");
  });

  it("CHAT streaming works", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ stream: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("chat.completion.chunk");
    expect(response.body).toContain("plain chat");
    expect(response.body).toContain("[DONE]");
  });

  it("CHAT with no grants rejects a request-supplied tool set", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [scopedTool("cmm.test.echo")] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.seen).toHaveLength(0);
    console.log("CHAT_UNSCOPED_ACTION=REJECTED");
    console.log("CHAT_ARBITRARY_TOOL_ACCESS=NONE");
  });

  it("CHAT granted scoped action completes a full client-owned roundtrip", async () => {
    const { server, provider, broker } = await harness({
      chatScopedActions: ["cmm.test.echo"],
    });
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [scopedTool("cmm.test.echo")] }),
    });
    expect(first.statusCode).toBe(200);
    const call = chatToolCall(first.json());
    expect(call.name).toBe("cmm.test.echo");
    // The provider sees the Router's canonical definition, never the caller's.
    expect(provider.seen[0]!.tools[0]!.function.description).toBe(
      "Return the supplied text unchanged.",
    );
    expect(provider.seen[0]!.profile).toBe("CHAT");
    expect(broker.activeCount()).toBe(1);

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({
        messages: continuationMessages(call),
        tools: [scopedTool("cmm.test.echo")],
      }),
    });
    expect(second.statusCode).toBe(200);
    expect(chatContent(second.json())).toBe('echo:{"text":"canary"}');
    expect(provider.seen[1]!.profile).toBe("CHAT");
    expect(broker.activeCount()).toBe(0);
    console.log("CHAT_SCOPED_ACTIONS=PASS");
  });

  it("CHAT registered but ungranted action is rejected", async () => {
    const { server, provider } = await harness({ chatScopedActions: ["cmm.test.echo"] });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [scopedTool("cmm.test.write")] }),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.seen).toHaveLength(0);
  });

  it("CHAT unknown action is rejected even when the request claims a grant", async () => {
    const { server, provider } = await harness({
      chatScopedActions: ["cmm.test.echo", "invented_tool"],
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [scopedTool("invented_tool")] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not registered");
    expect(provider.seen).toHaveLength(0);
  });

  it("CHAT mixed allowed and forbidden action fails closed without stripping", async () => {
    const { server, provider } = await harness({ chatScopedActions: ["cmm.test.echo"] });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({
        tools: [scopedTool("cmm.test.echo"), arbitraryTool("arbitrary_shell")],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.seen).toHaveLength(0);
  });

  it("CHAT scoped action works on /v1/responses", async () => {
    const { server, provider } = await harness({ chatScopedActions: ["cmm.test.echo"] });
    const tools = [
      {
        type: "function",
        name: "cmm.test.echo",
        description: "caller supplied",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ];
    const first = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(CHAT_TOKEN),
      payload: { model: MODEL, input: "hi", tools },
    });
    expect(first.statusCode).toBe(200);
    const output = (first.json() as {
      output: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
    }).output;
    const call = output.find((item) => item.type === "function_call");
    expect(call?.name).toBe("cmm.test.echo");
    expect(typeof call?.call_id).toBe("string");

    const second = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: auth(CHAT_TOKEN),
      payload: {
        model: MODEL,
        tools,
        input: [
          { role: "user", content: "hi" },
          {
            type: "function_call",
            call_id: call!.call_id,
            name: "cmm.test.echo",
            arguments: '{"text":"canary"}',
          },
          { type: "function_call_output", call_id: call!.call_id, output: "canary" },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(responsesText(second.json())).toBe('echo:{"text":"canary"}');
    expect(provider.seen[0]!.profile).toBe("CHAT");
  });
});

describe("Router profiles: CHAT cannot escalate", () => {
  it("header, body, client-name and capability claims never select AGENT", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...auth(CHAT_TOKEN),
        "x-router-profile": "AGENT",
        "x-consumer": "qoder",
        "x-client-name": "Qoder",
        "user-agent": "Qoder/1.0",
      },
      payload: chatPayload({
        profile: "AGENT",
        router_profile: "AGENT",
        consumer: "qoder",
        capabilities: ["CHAT_AND_TOOLS", "AGENT"],
        tools: [arbitraryTool("run_command")],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.seen).toHaveLength(0);
    console.log("CHAT_TO_AGENT_IMPLICIT_ESCALATION=NONE");
  });

  it("a Qoder-shaped tool name does not grant AGENT to CHAT", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth(CHAT_TOKEN), "user-agent": "Qoder/1.0", "x-consumer": "qoder" },
      payload: chatPayload({
        model: MODEL,
        tools: [arbitraryTool("qoder_execute_shell")],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(provider.seen).toHaveLength(0);
  });

  it("a CHAT token also configured as AGENT is rejected at startup", async () => {
    // Ambiguity is refused before any request is served: a secret that could
    // authenticate two profiles never silently degrades to the narrower one.
    const shared = "shared-chat-agent-token";
    await expect(
      harness({ bearerSecret: shared, codeRouterToken: shared, qoderToken: shared }),
    ).rejects.toThrow(/must be distinct/);
    console.log("CHAT_TOKEN_AGENT_FALLBACK=NONE");
  });

  it("a CHAT request with a valid scoped grant still reports profile CHAT", async () => {
    const { server, provider } = await harness({ chatScopedActions: ["cmm.test.echo"] });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth(CHAT_TOKEN), "x-router-profile": "AGENT" },
      payload: chatPayload({ tools: [scopedTool("cmm.test.echo")] }),
    });
    expect(response.statusCode).toBe(200);
    expect(provider.seen[0]!.profile).toBe("CHAT");
  });
});

describe("Router profiles: AGENT", () => {
  it("ordinary AGENT conversation works without tools", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(chatContent(response.json())).toBe("plain chat");
    console.log("AGENT_PROFILE=PASS");
  });

  it("AGENT arbitrary tool roundtrip and continuation", async () => {
    const { server, provider, broker } = await harness();
    const tool = arbitraryTool();
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({ tools: [tool] }),
    });
    expect(first.statusCode).toBe(200);
    const call = chatToolCall(first.json());
    expect(call.name).toBe("run_command");
    expect(provider.seen[0]!.profile).toBe("AGENT");
    expect(provider.seen[0]!.tools).toEqual([tool]);
    expect(broker.activeCount()).toBe(1);

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({ messages: continuationMessages(call), tools: [tool] }),
    });
    expect(second.statusCode).toBe(200);
    expect(chatContent(second.json())).toBe('echo:{"text":"canary"}');
    expect(broker.activeCount()).toBe(0);
    console.log("AGENT_EXISTING_TOOL_ROUNDTRIP=PASS");
  });

  it("AGENT streaming tool roundtrip", async () => {
    const { server } = await harness();
    const tool = arbitraryTool();
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({ tools: [tool] }),
    });
    const call = chatToolCall(first.json());
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({
        messages: continuationMessages(call),
        tools: [tool],
        stream: true,
      }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["content-type"]).toContain("text/event-stream");
    expect(sseText(second.body)).toBe('echo:{"text":"canary"}');
    expect(second.body).toContain("[DONE]");
    console.log("AGENT_STREAMING_TOOL_ROUNDTRIP=PASS");
  });

  it("AGENT cancellation reaches the provider adapter", { timeout: 15000 }, async () => {
    const registry = new ProviderRegistry();
    const provider = new HangingProvider();
    await registry.register(provider);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CHAT_TOKEN,
      codeRouterToken: CODE_TOKEN,
      registry,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth(CODE_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt/hanging-model", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    }).catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (!provider.entered && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provider.entered).toBe(true);
    controller.abort();
    const cancelDeadline = Date.now() + 5000;
    while (provider.cancelled.length === 0 && Date.now() < cancelDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provider.cancelled.length).toBeGreaterThan(0);
    await pending;
    await server.close();
    console.log("AGENT_CANCELLATION=PASS");
  });
});

describe("Router profile authentication and shared engine", () => {
  it("CHAT token resolves CHAT; Code token and legacy Qoder token resolve AGENT", async () => {
    const { server } = await harness();
    const chat = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [arbitraryTool()] }),
    });
    expect(chat.statusCode).toBe(400);

    for (const token of [CODE_TOKEN, QODER_TOKEN]) {
      const agent = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth(token),
        payload: chatPayload({ tools: [arbitraryTool()] }),
      });
      expect(agent.statusCode).toBe(200);
    }
    console.log("LEGACY_CODE_TOKEN_COMPATIBILITY=PASS");
    console.log("LEGACY_QODER_TOKEN_COMPATIBILITY=PASS");
  });

  it("unknown bearer is rejected and cannot reach a provider", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth("not-configured"),
      payload: chatPayload({ tools: [arbitraryTool()] }),
    });
    expect(response.statusCode).toBe(401);
    expect(provider.seen).toHaveLength(0);
  });

  it("one provider and one broker serve both profiles", async () => {
    const { server, provider, broker } = await harness({
      chatScopedActions: ["cmm.test.echo"],
    });

    const chatFirst = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({ tools: [scopedTool("cmm.test.echo")] }),
    });
    const chatCall = chatToolCall(chatFirst.json());
    const chatSecond = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CHAT_TOKEN),
      payload: chatPayload({
        messages: continuationMessages(chatCall),
        tools: [scopedTool("cmm.test.echo")],
      }),
    });
    expect(chatSecond.statusCode).toBe(200);

    const agentFirst = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({ tools: [arbitraryTool()] }),
    });
    const agentCall = chatToolCall(agentFirst.json());
    const agentSecond = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(CODE_TOKEN),
      payload: chatPayload({
        messages: continuationMessages(agentCall),
        tools: [arbitraryTool()],
      }),
    });
    expect(agentSecond.statusCode).toBe(200);

    expect(provider.seen.map((request) => request.profile)).toEqual([
      "CHAT",
      "CHAT",
      "AGENT",
      "AGENT",
    ]);
    expect(broker.activeCount()).toBe(0);
    console.log("ONE_SHARED_TOOL_ENGINE=YES");
  });
});
