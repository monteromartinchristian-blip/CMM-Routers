import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import {
  TOOL_KIND_POLICY,
  classifyToolDeclarationType,
} from "../../src/core/tool-kind.js";

/**
 * Subphase C — both ingress surfaces classify tool declarations identically.
 *
 * The classification is a property of the declaration, not of the surface and
 * certainly not of the client: the same wire class produces the same decision on
 * Chat Completions and on Responses.
 */

const CMMCHAT_TOKEN = "tool-kind-cmmchat-secret";
const CODE_TOKEN = "tool-kind-code-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

const FN_CHAT = {
  type: "function",
  function: {
    name: "cmm_echo",
    description: "Return the supplied text unchanged.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
};
const FN_RESPONSES = {
  type: "function",
  name: "cmm_echo",
  description: "Return the supplied text unchanged.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

async function harness() {
  const registry = new ProviderRegistry();
  const provider = new GenericToolProvider({
    provider: "command-code",
    modelId: MODEL,
    steps: [{ kind: "final", prefix: "answer=" }],
  });
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

async function chat(server: ReturnType<typeof buildServer>, tool: unknown) {
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: AUTH,
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [tool] },
  });
}

async function responses(server: ReturnType<typeof buildServer>, tool: unknown) {
  return server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: AUTH,
    payload: { model: MODEL, input: "hi", tools: [tool] },
  });
}

describe("tool-kind policy parity across ingress surfaces", () => {
  it("accepts a client-owned function on both surfaces", async () => {
    const { server, provider } = await harness();
    expect((await chat(server, FN_CHAT)).statusCode).toBe(200);
    expect((await responses(server, FN_RESPONSES)).statusCode).toBe(200);
    expect(provider.runCount).toBe(2);
  });

  it("refuses a namespace declaration identically on both surfaces", async () => {
    const { server, provider } = await harness();
    const namespaceTool = { type: "namespace", name: "group", tools: [] };
    for (const response of [await chat(server, namespaceTool), await responses(server, namespaceTool)]) {
      expect(response.statusCode).toBe(400);
      const error = (response.json() as { error: { type: string; message: string } }).error;
      expect(error.type).toBe("unsupported_capability");
      expect(error.message).toContain("namespace");
    }
    expect(provider.runCount).toBe(0);
    console.log("NAMESPACE_TOOL_REFUSED_ON_BOTH_SURFACES=PASS");
  });

  it("refuses a hosted tool identically on both surfaces", async () => {
    const { server, provider } = await harness();
    const hosted = { type: "web_search" };
    for (const response of [await chat(server, hosted), await responses(server, hosted)]) {
      expect(response.statusCode).toBe(400);
      const error = (response.json() as { error: { message: string } }).error;
      expect(error.message).toContain("hosted");
      expect(error.message).toContain("web_search");
    }
    expect(provider.runCount).toBe(0);
    console.log("HOSTED_TOOL_REFUSED_ON_BOTH_SURFACES=PASS");
  });

  it("fails closed on an unrecognized declaration class on both surfaces", async () => {
    const { server, provider } = await harness();
    for (const unknown of [{ type: "future_tool_kind" }, { type: "FUNCTION" }, {}]) {
      for (const response of [await chat(server, unknown), await responses(server, unknown)]) {
        expect(response.statusCode).toBe(400);
        expect((response.json() as { error: { type: string } }).error.type).toBe(
          "unsupported_capability",
        );
      }
    }
    expect(provider.runCount).toBe(0);
    console.log("UNKNOWN_TOOL_CLASS_FAILS_CLOSED_ON_BOTH_SURFACES=PASS");
  });

  it("never partially accepts a mixed declaration list", async () => {
    const { server, provider } = await harness();
    const mixed = [FN_CHAT, { type: "namespace", name: "group", tools: [] }];
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: mixed },
    });
    expect(response.statusCode).toBe(400);
    // The representable function must not have been forwarded on its own.
    expect(provider.runCount).toBe(0);
    console.log("NO_PARTIAL_TOOL_ACCEPTANCE=PASS");
  });

  it("the published policy table is the single source of truth", () => {
    expect(TOOL_KIND_POLICY.function).toBe("SUPPORTED");
    expect(TOOL_KIND_POLICY.namespace).toBe("EXPLICIT_UNSUPPORTED");
    expect(TOOL_KIND_POLICY.hosted).toBe("EXPLICIT_UNSUPPORTED");
    expect(TOOL_KIND_POLICY.unknown).toBe("FAIL_CLOSED");
    expect(classifyToolDeclarationType("function")).toBe("function");
  });
});
