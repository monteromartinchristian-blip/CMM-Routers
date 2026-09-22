import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import {
  GenericToolProvider,
  type GenericToolScriptStep,
} from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * The canonical client-agnostic proof.
 *
 * Identity used here is a generic OpenAI-compatible harness:
 *   - it authenticates with the canonical Code Router bearer (never the legacy
 *     Qoder alias);
 *   - it sends no `X-CMM-Client` header, so the Router defaults it to
 *     `generic-openai`;
 *   - it depends on no Qoder registration, setting or provider id.
 *
 * The tool is harmless and synthetic: nothing touches the filesystem, shell,
 * network or a repository. The Router never executes it; the test client does.
 */

const CMMCHAT_TOKEN = "generic-proof-cmmchat-secret";
const CODE_TOKEN = "generic-proof-code-secret";

const MODEL = "command-code/generic-echo";
const CHAT_ONLY_MODEL = "command-code/generic-chat-only";

type ChatBody = {
  model: string;
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
  }>;
};

describe("generic Code Router client — canonical Chat Completions contract", () => {
  let registry: ProviderRegistry;
  let provider: GenericToolProvider;

  function makeServer() {
    return buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      codeRouterToken: CODE_TOKEN,
      registry,
    });
  }

  async function register(steps: GenericToolScriptStep[], capability?: "CHAT_ONLY") {
    registry = new ProviderRegistry();
    provider = new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      ...(capability ? { capability } : {}),
      steps,
      extraModels: [
        {
          id: CHAT_ONLY_MODEL,
          provider: "command-code",
          upstreamModel: "generic-chat-only",
          displayName: "Generic Chat Only Model",
          capability: "CHAT_ONLY",
        },
      ],
    });
    await registry.register(provider);
    await registry.refresh();
    return makeServer();
  }

  /** The generic client: canonical bearer, no client metadata header. */
  const GENERIC_AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

  beforeEach(async () => {
    await register([
      { kind: "calls", calls: [{ id: "gcall_1", name: "cmm_echo", arguments: '{"text":"alpha"}' }] },
      { kind: "final", prefix: "answer=" },
    ]);
  });

  it("GENERIC_OPENAI_CODE_ROUTER: canonical auth + exact model + structured round trip", async () => {
    const server = makeServer();

    // 1-3. discovery: the exact model is advertised CHAT_AND_TOOLS.
    const models = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: GENERIC_AUTH,
    });
    expect(models.statusCode).toBe(200);
    const advertised = (models.json() as { data: Array<{ id: string; x_cmm?: { code_router?: string } }> }).data;
    const exact = advertised.find((model) => model.id === MODEL);
    expect(exact?.x_cmm?.code_router).toBe("CHAT_AND_TOOLS");
    console.log("GENERIC_OPENAI_MODEL_DISCOVERY=PASS");

    // 4-7. the model emits a structured call and the Router surfaces it.
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "run the echo tool" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ChatBody;
    expect(firstBody.model).toBe(MODEL);
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const call = firstBody.choices[0]!.message.tool_calls![0]!;
    expect(call.type).toBe("function");
    expect(call.id).toBe("gcall_1");
    expect(call.function.name).toBe("cmm_echo");
    expect(call.function.arguments).toBe('{"text":"alpha"}');
    console.log("GENERIC_OPENAI_TOOL_ROUNDTRIP=PASS");

    // 8. the CLIENT executes the tool (simulated here) and submits the result.
    const result = "CLIENT_EXECUTED_9f31";
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        messages: [
          { role: "user", content: "run the echo tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: "cmm_echo", arguments: call.function.arguments },
              },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: result },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ChatBody;
    expect(secondBody.model).toBe(MODEL);
    expect(secondBody.choices[0]!.finish_reason).toBe("stop");

    // 9-11. the same provider/model continued, and the final answer is causally
    // derived from the client-supplied result and its preserved id.
    expect(secondBody.choices[0]!.message.content).toBe(`answer=[ids=gcall_1][results=${result}]`);
    console.log("CLIENT_OWNS_TOOLS=YES");
    console.log("PROVIDER_NATIVE_TOOL_EXECUTION=NONE");
  });

  it("the provider received the structured declaration and the preserved continuation", async () => {
    const server = makeServer();
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "run the echo tool" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    const call = (first.json() as ChatBody).choices[0]!.message.tool_calls![0]!;

    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: MODEL,
        messages: [
          { role: "user", content: "run the echo tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: call.id, type: "function", function: { name: "cmm_echo", arguments: '{"text":"alpha"}' } },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: "client-result" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });

    expect(provider.turns[0]!.declaredTools).toEqual(["cmm_echo"]);
    expect(provider.turns[0]!.modelId).toBe(MODEL);
    // The assistant tool-call history and the tool-result id both round-tripped
    // byte-exact: the Router did not reconstruct either.
    expect(provider.turns[1]!.assistantToolCallIds).toEqual([["gcall_1"]]);
    expect(provider.turns[1]!.toolResults).toEqual([{ id: "gcall_1", content: "client-result" }]);
    expect(provider.turns[1]!.modelId).toBe(MODEL);
  });

  it("EXACT_MODEL_SELECTION: an unknown model fails closed without invoking any provider", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: "command-code/does-not-exist",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
    expect(provider.runCount).toBe(0);
    console.log("EXACT_MODEL_SELECTION=PASS");
    console.log("NO_UNKNOWN_MODEL_FALLBACK=YES");
  });

  it("a CHAT_ONLY model advertised to the same client cannot serve tools", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: {
        model: CHAT_ONLY_MODEL,
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.runCount).toBe(0);
    console.log("CHAT_ONLY_REJECTION_INTACT=PASS");
  });

  it("the CMMChat bearer stays CHAT_ONLY for the same generic request", async () => {
    const server = makeServer();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}` },
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "run the echo tool" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(provider.runCount).toBe(0);
    console.log("CMMCHAT_CHAT_ONLY=PASS");
  });

  it("multi-step: tool A -> result A -> tool B -> result B -> final", async () => {
    const server = await register([
      { kind: "calls", calls: [{ id: "gcall_A", name: "cmm_echo", arguments: '{"text":"A"}' }] },
      { kind: "calls", calls: [{ id: "gcall_B", name: "cmm_echo", arguments: '{"text":"B"}' }] },
      { kind: "final", prefix: "multi=" },
    ]);

    const history: Array<Record<string, unknown>> = [{ role: "user", content: "run both" }];
    const results = ["RESULT_A", "RESULT_B"];
    const confirmedIds: string[] = [];

    for (let round = 0; round < 2; round += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: GENERIC_AUTH,
        payload: { model: MODEL, messages: history, tools: [CMM_ECHO_TOOL] },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as ChatBody;
      expect(body.choices[0]!.finish_reason).toBe("tool_calls");
      const call = body.choices[0]!.message.tool_calls![0]!;
      confirmedIds.push(call.id);
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } },
        ],
      });
      history.push({ role: "tool", tool_call_id: call.id, content: results[round] });
    }

    expect(confirmedIds).toEqual(["gcall_A", "gcall_B"]);

    const final = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: GENERIC_AUTH,
      payload: { model: MODEL, messages: history, tools: [CMM_ECHO_TOOL] },
    });
    expect(final.statusCode).toBe(200);
    const finalBody = final.json() as ChatBody;
    expect(finalBody.choices[0]!.finish_reason).toBe("stop");
    // Causal: the terminal answer depends on information introduced only by the
    // two client-executed results.
    expect(finalBody.choices[0]!.message.content).toBe(
      "multi=[ids=gcall_A,gcall_B][results=RESULT_A|RESULT_B]",
    );
    expect(provider.turns).toHaveLength(3);
    console.log("GENERIC_MULTISTEP_ROUNDTRIP=PASS");
  });
});

describe("generic Code Router client — tool policy forwarding", () => {
  it("forwards tool_choice to a provider that represents it truthfully", async () => {
    const registry = new ProviderRegistry();
    const provider = new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        { kind: "calls", calls: [{ id: "gcall_1", name: "cmm_echo", arguments: "{}" }] },
        { kind: "final", prefix: "done" },
      ],
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
    const auth = { authorization: `Bearer ${CODE_TOKEN}` };

    const cases: Array<[unknown, unknown]> = [
      ["auto", { kind: "auto" }],
      ["none", { kind: "none" }],
      ["required", { kind: "required" }],
      [{ type: "function", function: { name: "cmm_echo" } }, { kind: "named", name: "cmm_echo" }],
    ];
    for (const [wire, normalized] of cases) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: auth,
        payload: {
          model: MODEL,
          messages: [{ role: "user", content: "hi" }],
          tools: [CMM_ECHO_TOOL],
          tool_choice: wire,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(provider.turns.at(-1)!.toolChoice).toEqual(normalized);
    }
    console.log("TOOL_CHOICE_FORWARDED=PASS");
  });

  it("forwards parallel_tool_calls instead of silently dropping it", async () => {
    const registry = new ProviderRegistry();
    const provider = new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        {
          kind: "calls",
          calls: [
            { id: "gcall_p1", name: "cmm_echo", arguments: '{"text":"p1"}' },
            { id: "gcall_p2", name: "cmm_echo", arguments: '{"text":"p2"}' },
          ],
        },
        { kind: "final", prefix: "parallel=" },
      ],
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
    const auth = { authorization: `Bearer ${CODE_TOKEN}` };

    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
        parallel_tool_calls: true,
      },
    });
    expect(first.statusCode).toBe(200);
    expect(provider.turns[0]!.parallelToolCalls).toBe(true);

    const calls = (first.json() as ChatBody).choices[0]!.message.tool_calls!;
    expect(calls.map((call) => call.id)).toEqual(["gcall_p1", "gcall_p2"]);

    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: MODEL,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.function.name, arguments: call.function.arguments },
            })),
          },
          { role: "tool", tool_call_id: "gcall_p1", content: "R1" },
          { role: "tool", tool_call_id: "gcall_p2", content: "R2" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as ChatBody).choices[0]!.message.content).toBe(
      "parallel=[ids=gcall_p1,gcall_p2][results=R1|R2]",
    );
    console.log("PARALLEL_TOOL_CALLS_FORWARDED=PASS");
  });
});
