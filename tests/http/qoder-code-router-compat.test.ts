import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CLIENT_QODER } from "../../src/core/client-identity.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Phase 4B — Qoder remains a fully supported compatibility target without being
 * an authorization role.
 *
 * Both the legacy Qoder bearer and the canonical Code Router bearer authenticate
 * the same Code Router profile. Qoder is not required to be the caller for tools
 * to work, and nothing in this flow consults a Qoder identity to decide
 * capability.
 */

const CMMCHAT_TOKEN = "qoder-compat-cmmchat-secret";
const CODE_TOKEN = "qoder-compat-code-secret";
const LEGACY_TOKEN = "qoder-compat-legacy-secret";
const MODEL = "command-code/generic-echo";

interface ChatBody {
  model: string;
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

async function harness() {
  const registry = new ProviderRegistry();
  await registry.register(
    new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        { kind: "calls", calls: [{ id: "gcall_q", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
        { kind: "final", prefix: "answer=" },
      ],
      extraModels: [
        {
          id: "command-code/chat-only",
          provider: "command-code",
          upstreamModel: "chat-only",
          displayName: "Chat Only",
          capability: "CHAT_ONLY",
        },
      ],
    }),
  );
  await registry.refresh();
  // Both Code Router credentials configured, as in a migrated installation.
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    qoderToken: LEGACY_TOKEN,
    registry,
  });
  return { server };
}

async function roundTrip(
  server: ReturnType<typeof buildServer>,
  headers: Record<string, string>,
): Promise<ChatBody> {
  const first = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: {
      model: MODEL,
      messages: [{ role: "user", content: "echo" }],
      tools: [CMM_ECHO_TOOL],
    },
  });
  expect(first.statusCode).toBe(200);
  const firstBody = first.json() as ChatBody;
  const call = firstBody.choices[0]!.message.tool_calls![0]!;

  const second = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
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
        { role: "tool", tool_call_id: call.id, content: "QODER_RESULT" },
      ],
      tools: [CMM_ECHO_TOOL],
    },
  });
  expect(second.statusCode).toBe(200);
  return second.json() as ChatBody;
}

describe("Qoder Code Router compatibility (Router side)", () => {
  it("QODER_LEGACY_COMPATIBILITY: the legacy Qoder bearer completes the tool round trip", async () => {
    const { server } = await harness();
    const body = await roundTrip(server, { authorization: `Bearer ${LEGACY_TOKEN}` });
    expect(body.model).toBe(MODEL);
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(body.choices[0]!.message.content).toBe("answer=[ids=gcall_q][results=QODER_RESULT]");
    console.log("QODER_LEGACY_COMPATIBILITY=PASS");
  });

  it("the canonical Code Router bearer works for Qoder without the legacy bearer", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      new GenericToolProvider({
        provider: "command-code",
        modelId: MODEL,
        steps: [
          { kind: "calls", calls: [{ id: "gcall_q", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
          { kind: "final", prefix: "answer=" },
        ],
      }),
    );
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      codeRouterToken: CODE_TOKEN,
      registry,
    });
    const body = await roundTrip(server, {
      authorization: `Bearer ${CODE_TOKEN}`,
      "x-cmm-client": CLIENT_QODER,
    });
    expect(body.choices[0]!.message.content).toBe("answer=[ids=gcall_q][results=QODER_RESULT]");
    console.log("QODER_CODE_ROUTER=DETERMINISTIC_PASS_REAL_GATE_PENDING");
  });

  it("exact model selection applies to Qoder too", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      payload: { model: "command-code/missing", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
  });

  it("a Qoder-authenticated request cannot use tools on a CHAT_ONLY model", async () => {
    const { server } = await harness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      payload: {
        model: "command-code/chat-only",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
  });

  it("Qoder is not required: an unidentified generic client gets the same capability", async () => {
    const { server } = await harness();
    const generic = await roundTrip(server, { authorization: `Bearer ${CODE_TOKEN}` });
    const qoder = await roundTrip(server, {
      authorization: `Bearer ${LEGACY_TOKEN}`,
      "x-cmm-client": CLIENT_QODER,
    });
    expect(generic.choices[0]!.message.content).toBe(qoder.choices[0]!.message.content);
    console.log("AUTHORIZATION_IS_PROFILE_NOT_CLIENT=PASS");
  });
});
