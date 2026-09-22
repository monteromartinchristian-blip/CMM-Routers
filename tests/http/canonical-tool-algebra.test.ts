import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import {
  representToolDeclaration,
  TOOL_KIND_POLICY,
} from "../../src/core/tool-kind.js";
import { isFunctionTool, type RouterTool } from "../../src/core/model.js";

/**
 * Finding P3 — the canonical tool algebra must be genuinely extensible.
 *
 * The classifier alone did not make the canonical model extensible: `RouterTool`
 * was still structurally function-only. The declaration model is now a
 * discriminated union that can represent every class, while the executable path
 * remains narrowed to client-owned functions.
 *
 * Representable does not mean executable or allowed.
 */

const CMMCHAT_TOKEN = "algebra-cmmchat-secret";
const CODE_TOKEN = "algebra-code-secret";
const MODEL = "command-code/algebra-model";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

async function harness() {
  const registry = new ProviderRegistry();
  const provider = new GenericToolProvider({
    provider: "command-code",
    modelId: MODEL,
    steps: [{ kind: "final", prefix: "done=" }],
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

describe("canonical Router tool algebra", () => {
  it("CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE: every class is representable", () => {
    const fn = representToolDeclaration("function", {
      type: "function",
      name: "cmm_echo",
      parameters: { type: "object" },
    });
    const ns = representToolDeclaration("namespace", { type: "namespace", name: "group" });
    const hosted = representToolDeclaration("hosted", { type: "web_search" });
    const unknown = representToolDeclaration("unknown", { type: "future_kind" });

    const kinds = [fn, ns, hosted, unknown].map((tool: RouterTool) => tool.type);
    expect(kinds).toEqual(["function", "namespace", "web_search", "future_kind"]);
    // Only the function variant is executable.
    expect(isFunctionTool(fn)).toBe(true);
    expect(isFunctionTool(ns)).toBe(false);
    expect(isFunctionTool(hosted)).toBe(false);
    expect(isFunctionTool(unknown)).toBe(false);
    console.log("CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES");
  });

  it("a represented function carries structured parameters", () => {
    const fn = representToolDeclaration("function", {
      type: "function",
      name: "cmm_echo",
      description: "echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    });
    expect(isFunctionTool(fn)).toBe(true);
    if (!isFunctionTool(fn)) throw new Error("unreachable");
    expect(fn.function.name).toBe("cmm_echo");
    expect(fn.function.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("policy still governs executability, not representability", () => {
    expect(TOOL_KIND_POLICY.function).toBe("SUPPORTED");
    expect(TOOL_KIND_POLICY.namespace).toBe("EXPLICIT_UNSUPPORTED");
    expect(TOOL_KIND_POLICY.hosted).toBe("EXPLICIT_UNSUPPORTED");
    expect(TOOL_KIND_POLICY.unknown).toBe("FAIL_CLOSED");
  });

  it("UNSUPPORTED_TOOL_NEVER_REACHES_PROVIDER: non-function classes stop at the boundary", async () => {
    const { server, provider } = await harness();
    const cases: unknown[] = [
      { type: "namespace", name: "group", tools: [] },
      { type: "web_search" },
      { type: "future_kind" },
    ];
    for (const tool of cases) {
      const chat = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: AUTH,
        payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [tool] },
      });
      expect(chat.statusCode).toBe(400);

      const responses = await server.inject({
        method: "POST",
        url: "/v1/responses",
        headers: AUTH,
        payload: { model: MODEL, input: "hi", tools: [tool] },
      });
      expect(responses.statusCode).toBe(400);
    }
    expect(provider.runCount).toBe(0);
    console.log("UNSUPPORTED_TOOL_NEVER_REACHES_PROVIDER=PASS");
  });

  it("a function-only list still round-trips through the narrowed executable path", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "cmm_echo", parameters: { type: "object" } },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.turns[0]!.declaredTools).toEqual(["cmm_echo"]);
  });
});
