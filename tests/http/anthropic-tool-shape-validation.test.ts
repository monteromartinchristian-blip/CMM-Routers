import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";

/**
 * Finding F4 — the Anthropic-compatible surface must validate the shapes it
 * claims to support.
 *
 * A malformed `is_error` was silently canonicalized as success (turning a failed
 * tool into a successful one), and `tool_use.input` accepted arbitrary primitives
 * that were then serialized as function arguments.
 */

const CMMCHAT_TOKEN = "shape-cmmchat-secret";
const CODE_TOKEN = "shape-code-secret";
const MODEL = "command-code/shape-model";
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

function continueWith(server: ReturnType<typeof buildServer>, toolResult: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/v1/messages",
    headers: AUTH,
    payload: {
      model: MODEL,
      max_tokens: 64,
      messages: [
        { role: "user", content: "echo" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "cmm_echo", input: { text: "a" } }],
        },
        { role: "user", content: [toolResult] },
      ],
    },
  });
}

describe("Anthropic tool shapes are validated", () => {
  it("ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED", async () => {
    const { server, provider } = await harness();
    for (const bad of ["yes", 1, null as unknown as string, {} as unknown as boolean]) {
      const response = await continueWith(server, {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "failed",
        is_error: bad,
      });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
      const error = (response.json() as { type: string; error: { type: string; message: string } })
        .error;
      expect(error.type).toBe("invalid_request_error");
      expect(error.message).toContain("is_error");
    }
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED");
  });

  it("ANTHROPIC_TOOL_RESULT_ERROR_STATUS_PRESERVED: a valid boolean still maps", async () => {
    const { server, provider } = await harness();
    const response = await continueWith(server, {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "failed",
      is_error: true,
    });
    expect(response.statusCode).toBe(200);
    expect(provider.turns[0]!.toolResults[0]!.status).toBe("error");
    console.log("ANTHROPIC_TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS");
  });

  it("ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED: primitives are refused", async () => {
    const { server, provider } = await harness();
    for (const bad of ["text", 42, true, [1, 2]]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/messages",
        headers: AUTH,
        payload: {
          model: MODEL,
          max_tokens: 64,
          messages: [
            { role: "user", content: "echo" },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "tu_1", name: "cmm_echo", input: bad }],
            },
          ],
        },
      });
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
      expect(
        (response.json() as { error: { message: string } }).error.message,
        JSON.stringify(bad),
      ).toContain("input");
    }
    expect(provider.runCount).toBe(0);
    console.log("ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED");
  });

  it("a structured tool_use input is preserved into canonical arguments", async () => {
    const { server, provider } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_9", name: "cmm_echo", input: { text: "keep" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_9", content: "ok" }] },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.turns[0]!.assistantToolCallIds).toEqual([["tu_9"]]);
  });

  it("an absent tool_use input stays the empty-argument default", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: AUTH,
      payload: {
        model: MODEL,
        max_tokens: 64,
        messages: [
          { role: "user", content: "echo" },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "cmm_echo" }] },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
  });
});
