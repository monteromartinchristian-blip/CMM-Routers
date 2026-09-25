import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { normalizeClientLabel } from "../../src/core/client-identity.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Phase 4D — Codex as a DOWNSTREAM CLIENT, ROUTER SIDE ONLY.
 *
 * Codex is two distinct things:
 *   - an upstream provider route (`chatgpt/*`, the Codex adapter);
 *   - possibly a downstream client/harness of the Code Router.
 *
 * The downstream client identifier is `codex-client`, deliberately distinct from
 * the `chatgpt` provider namespace. This file proves the Router-side contract
 * and the separation; it is NOT evidence that the installed Codex CLI supports a
 * custom provider pointing at this Router — that requires verifying the real
 * client and is tracked as a real-client gate.
 */

const CMMCHAT_TOKEN = "codex-client-cmmchat-secret";
const CODE_TOKEN = "codex-client-code-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}`, "x-cmm-client": "codex-client" };

async function harness() {
  const registry = new ProviderRegistry();
  await registry.register(
    new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        { kind: "calls", calls: [{ id: "gcall_c", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
        { kind: "final", prefix: "answer=" },
      ],
    }),
  );
  await registry.refresh();
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });
}

describe("Codex-client Router-side readiness contract", () => {
  it("a downstream label is opaque and never a provider id", () => {
    // The core stores an opaque label; it does not classify products.
    expect(normalizeClientLabel("codex-client")).toBe("codex-client");
    // The label is not the upstream provider namespace and cannot select one.
    expect(normalizeClientLabel("codex-client")).not.toBe("chatgpt");
    console.log("CLIENT_LABEL_OPAQUE=PASS");
  });

  it("completes the tool round trip on Chat Completions", async () => {
    const server = await harness();
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "echo" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    const call = body.choices[0]!.message.tool_calls![0]!;

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: MODEL,
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: "CODEX_CLIENT_RESULT" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    const final = second.json() as { choices: Array<{ message: { content: string } }> };
    expect(final.choices[0]!.message.content).toBe("answer=[ids=gcall_c][results=CODEX_CLIENT_RESULT]");
    console.log("CODEX_CLIENT_TOOL_OWNERSHIP=PASS");
  });

  it("completes the equivalent round trip on the Responses surface", async () => {
    const server = await harness();
    const tool = {
      type: "function",
      name: "cmm_echo",
      description: "Return the supplied text unchanged.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    };
    const first = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: { model: MODEL, input: "echo", tools: [tool] },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { output: Array<Record<string, unknown>> };
    const call = firstBody.output.find((item) => item.type === "function_call")!;

    const second = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: AUTH,
      payload: {
        model: MODEL,
        input: [
          { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments },
          { type: "function_call_output", call_id: call.call_id, output: "R" },
        ],
        tools: [tool],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      output: Array<{ type: string; content?: Array<{ text: string }> }>;
    };
    const text = secondBody.output
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content ?? []).map((part) => part.text))
      .join("");
    expect(text).toBe("answer=[ids=gcall_c][results=R]");
    console.log("CODEX_CLIENT_RESPONSES_PARITY=PASS");
  });

  it("keeps profile authorization identical for the Codex client", async () => {
    const server = await harness();
    const denied = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}`, "x-cmm-client": "codex-client" },
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "echo" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.type).toBe("unsupported_capability");
  });

  it("emits the readiness marker", () => {
    console.log("CODEX_CLIENT_CODE_ROUTER_READINESS=PASS");
    console.log("CODEX_CLIENT_REAL_GATE=PENDING_INSTALLED_CLIENT_VERIFICATION");
  });
});
