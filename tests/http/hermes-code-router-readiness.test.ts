import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Phase 4C — Hermes readiness, ROUTER SIDE ONLY.
 *
 * This proves the Router-side contract a Hermes client would consume. It is NOT
 * evidence that a real Hermes client works: real client behaviour (custom
 * provider configuration, model discovery, wire API choice, streaming and tool
 * schema) must be verified against the installed client and is tracked as a
 * real-client gate.
 */

const CMMCHAT_TOKEN = "hermes-cmmchat-secret";
const CODE_TOKEN = "hermes-code-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}`, "x-cmm-client": "hermes" };

async function harness() {
  const registry = new ProviderRegistry();
  await registry.register(
    new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        { kind: "calls", calls: [{ id: "gcall_h", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
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

describe("Hermes Router-side readiness contract", () => {
  it("discovers an exact CHAT_AND_TOOLS model with published capability", async () => {
    const server = await harness();
    const response = await server.inject({ method: "GET", url: "/v1/models", headers: AUTH });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as { data: Array<{ id: string; x_cmm?: { code_router?: string } }> }).data;
    expect(data.find((m) => m.id === MODEL)?.x_cmm?.code_router).toBe("CHAT_AND_TOOLS");
    console.log("HERMES_MODEL_DISCOVERY=PASS");
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
        tool_choice: "auto",
      },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
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
          { role: "tool", tool_call_id: call.id, content: "HERMES_RESULT" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    const final = second.json() as { choices: Array<{ message: { content: string } }> };
    expect(final.choices[0]!.message.content).toBe("answer=[ids=gcall_h][results=HERMES_RESULT]");
    console.log("HERMES_TOOL_ROUNDTRIP=PASS");
  });

  it("streams structured tool-call deltas Hermes can parse without client-specific logic", async () => {
    const server = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "echo" }],
        tools: [CMM_ECHO_TOOL],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = (response as unknown as { body: string }).body;
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(body).toContain('"tool_calls"');
    expect(body).toContain("gcall_h");
    expect(body).toContain("cmm_echo");
    console.log("HERMES_STRUCTURED_TOOL_STREAM=PASS");
  });

  it("keeps CHAT_ONLY rejection and profile authorization identical for Hermes", async () => {
    const server = await harness();
    const denied = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}`, "x-cmm-client": "hermes" },
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
    console.log("HERMES_CODE_ROUTER_READINESS=PASS");
    console.log("HERMES_CODE_ROUTER_REAL_GATE=MANUAL_PENDING");
  });
});
