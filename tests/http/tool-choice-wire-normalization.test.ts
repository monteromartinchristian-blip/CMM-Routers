import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import type { ProviderId, RouterRequest } from "../../src/core/model.js";
import { RouterError } from "../../src/core/errors.js";

/**
 * Each public surface has its OWN canonical `tool_choice` wire shape. These
 * tests deliberately send the literal per-API shape (never one shared object
 * reused for both surfaces) so a wire-normalization regression cannot hide
 * behind a shared subset.
 */
const CHAT_NAMED_TOOL_CHOICE = { type: "function", function: { name: "t" } };
const RESPONSES_NAMED_TOOL_CHOICE = { type: "function", name: "t" };
const NORMALIZED_NAMED = { kind: "named", name: "t" };

const CHAT_TOOLS = [{ type: "function", function: { name: "t", parameters: {} } }];
const RESPONSES_TOOLS = [{ type: "function", name: "t", parameters: {} }];

const seen: RouterRequest[] = [];

function captureAdapter(id: ProviderId): ProviderAdapter {
  return {
    id,
    async discoverModels() {
      return [
        {
          id: `${id}/m`,
          provider: id,
          upstreamModel: "m",
          displayName: "m",
          capability: "CHAT_AND_TOOLS",
        },
      ];
    },
    async health() {
      return { status: "ready" };
    },
    async *run(request) {
      seen.push(request);
      yield { type: "completed", finishReason: "stop" };
    },
    async cancel() {},
  };
}

async function serverFor(id: ProviderId) {
  const registry = new ProviderRegistry();
  await registry.register(captureAdapter(id));
  await registry.refresh();
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: "c",
    qoderToken: "q",
    registry,
  });
}

async function postChat(id: ProviderId, toolChoice: unknown) {
  const server = await serverFor(id);
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer q" },
    payload: {
      model: `${id}/m`,
      messages: [{ role: "user", content: "hi" }],
      tools: CHAT_TOOLS,
      tool_choice: toolChoice,
    },
  });
}

async function postResponses(id: ProviderId, toolChoice: unknown) {
  const server = await serverFor(id);
  return server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer q" },
    payload: {
      model: `${id}/m`,
      input: "hi",
      tools: RESPONSES_TOOLS,
      tool_choice: toolChoice,
    },
  });
}

describe("API-specific tool_choice wire normalization", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("Chat surface accepts the literal nested named-function shape and normalizes it", async () => {
    const res = await postChat("command-code", CHAT_NAMED_TOOL_CHOICE);
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolChoice).toEqual(NORMALIZED_NAMED);
  });

  it("Responses surface accepts the literal FLAT named-function shape and normalizes it to the same value", async () => {
    const res = await postResponses("command-code", RESPONSES_NAMED_TOOL_CHOICE);
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolChoice).toEqual(NORMALIZED_NAMED);
  });

  it("both parsers map their own wire shape onto the identical internal form", async () => {
    const { parseChatToolChoice, parseResponsesToolChoice } = await import(
      "../../src/core/tool-policy.js"
    );
    const chat = parseChatToolChoice(CHAT_NAMED_TOOL_CHOICE);
    const responses = parseResponsesToolChoice(RESPONSES_NAMED_TOOL_CHOICE);
    expect(chat).toEqual(NORMALIZED_NAMED);
    expect(responses).toEqual(chat);
  });

  it("both parsers accept the three string forms and absence", async () => {
    const { parseChatToolChoice, parseResponsesToolChoice } = await import(
      "../../src/core/tool-policy.js"
    );
    for (const parse of [parseChatToolChoice, parseResponsesToolChoice]) {
      expect(parse("auto")).toEqual({ kind: "auto" });
      expect(parse("none")).toEqual({ kind: "none" });
      expect(parse("required")).toEqual({ kind: "required" });
      expect(parse(undefined)).toBeUndefined();
    }
  });

  it("each parser is strict and rejects the OTHER API's wire shape as invalid_request", async () => {
    const { parseChatToolChoice, parseResponsesToolChoice } = await import(
      "../../src/core/tool-policy.js"
    );
    // Chat Completions defines no flat named-function form...
    const chatRejectsFlat = parseChatToolChoice(RESPONSES_NAMED_TOOL_CHOICE);
    expect(chatRejectsFlat).toBeInstanceOf(RouterError);
    expect((chatRejectsFlat as RouterError).code).toBe("invalid_request");
    // ...and Responses defines no nested {function:{name}} form.
    const responsesRejectsNested = parseResponsesToolChoice(CHAT_NAMED_TOOL_CHOICE);
    expect(responsesRejectsNested).toBeInstanceOf(RouterError);
    expect((responsesRejectsNested as RouterError).code).toBe("invalid_request");
    // Hosted-tool object forms are out of scope for both surfaces.
    for (const parse of [parseChatToolChoice, parseResponsesToolChoice]) {
      const hosted = parse({ type: "web_search_preview" });
      expect(hosted).toBeInstanceOf(RouterError);
      expect((hosted as RouterError).code).toBe("invalid_request");
      const emptyName = parse({ type: "function" });
      expect(emptyName).toBeInstanceOf(RouterError);
    }
  });

  it("Responses rejects an out-of-scope hosted-tool tool_choice before provider invocation", async () => {
    const res = await postResponses("command-code", { type: "web_search_preview" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe("invalid_request");
    expect(seen).toHaveLength(0);
  });

  it("the two surfaces cannot diverge: identical provider policy from each canonical shape", async () => {
    expect((await postChat("command-code", CHAT_NAMED_TOOL_CHOICE)).statusCode).toBe(200);
    const chatPolicy = seen[0]!.toolChoice;
    seen.length = 0;
    expect((await postResponses("command-code", RESPONSES_NAMED_TOOL_CHOICE)).statusCode).toBe(200);
    expect(seen[0]!.toolChoice).toEqual(chatPolicy);
    console.log("CHAT_RESPONSES_WIRE_NORMALIZATION=IDENTICAL");
  });

  it("the Anthropic wire maps only the normalized policy, never a raw wire shape", async () => {
    const { buildAnthropicRequestBody } = await import(
      "../../src/providers/command-code/client.js"
    );
    const messages = [{ role: "user" as const, content: "hi" }];
    const named = buildAnthropicRequestBody("m", messages, 100, undefined, NORMALIZED_NAMED as never);
    expect(named.tool_choice).toEqual({ type: "tool", name: "t" });
    const none = buildAnthropicRequestBody("m", messages, 100, undefined, { kind: "none" } as never);
    expect(none.tool_choice).toEqual({ type: "none" });
    const required = buildAnthropicRequestBody("m", messages, 100, undefined, { kind: "required" } as never);
    expect(required.tool_choice).toEqual({ type: "any" });
    const auto = buildAnthropicRequestBody("m", messages, 100, undefined, { kind: "auto" } as never, false);
    expect(auto.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    // A raw public wire shape must never reach the Anthropic mapper.
    expect(() =>
      buildAnthropicRequestBody("m", messages, 100, undefined, CHAT_NAMED_TOOL_CHOICE as never),
    ).toThrow(RouterError);
  });
});
