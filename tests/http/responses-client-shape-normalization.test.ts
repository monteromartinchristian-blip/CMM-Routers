import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";

/**
 * Phase 7 — Responses boundary normalization for a real client shape.
 *
 * Capturing a real Codex CLI 0.147.0 request showed two shapes the Responses
 * surface previously mishandled:
 *   1. `role: "developer"` input items (Responses' system-level role);
 *   2. a tool list mixing client-owned `function` tools with grouped
 *      `namespace` tools and provider-hosted `web_search`.
 *
 * (1) is a genuine wire difference and is normalized to the internal `system`
 * role. (2) cannot be represented faithfully as client-owned functions, so the
 * request is refused precisely, by name, instead of silently dropping part of
 * what the caller declared.
 */

const CODE_TOKEN = "responses-shape-code-secret";
const CMMCHAT_TOKEN = "responses-shape-cmmchat-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

function fnTool(name: string) {
  return {
    type: "function",
    name,
    description: "Return the supplied text unchanged.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };
}

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

describe("Responses boundary normalization", () => {
  it("accepts the developer role and maps it to system-level instructions", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: "be terse" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
    console.log("RESPONSES_DEVELOPER_ROLE_NORMALIZED=PASS");
  });

  it("refuses a grouped namespace tool by name instead of dropping it", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        input: "hi",
        tools: [fnTool("cmm_echo"), { type: "namespace", name: "multi_agent_v1", tools: [] }],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.message).toContain("namespace");
    // Fail closed: the provider is never invoked with a partial tool set.
    expect(provider.runCount).toBe(0);
    console.log("RESPONSES_UNREPRESENTABLE_TOOL_REFUSED=PASS");
  });

  it("refuses a provider-hosted tool by name", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: { model: MODEL, input: "hi", tools: [fnTool("cmm_echo"), { type: "web_search" }] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("unsupported_capability");
    expect(body.error.message).toContain("web_search");
  });

  it("still accepts a pure function tool list", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: { model: MODEL, input: "hi", tools: [fnTool("cmm_echo")] },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.runCount).toBe(1);
  });

  it("still rejects a non-array tools field with a precise message", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: { model: MODEL, input: "hi", tools: "nope" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toBe(
      "tools must be an array",
    );
  });
});
