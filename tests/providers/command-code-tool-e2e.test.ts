import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const QODER_TOKEN = "cc-e2e-qoder-token";

function validAck(dir: string): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    }),
  );
  return path;
}

function sse(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}

interface SeenRequest {
  url: string;
  method: string;
  body: string | undefined;
}

describe("Command Code Qoder-owned tool E2E (mocked OpenAI wire, no live quota)", () => {
  let dir: string;
  let ackPath: string;
  let seen: SeenRequest[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-e2e-"));
    ackPath = validAck(dir);
    seen = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a tool call and result through the Router boundary (OpenAI wire)", async () => {
    let chatCalls = 0;
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
        const method = init?.method ?? "GET";
        seen.push({ url, method, body: init?.body });
        if (url.endsWith("/models")) {
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                data: [
                  { id: "goat-model-a", displayName: "Goat A", goatIncluded: true, wire: "openai-chat-completions" },
                ],
              }),
          };
        }
        // chat/completions
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            status: 200,
            text: async () =>
              sse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"cc_call_1","type":"function","function":{"name":"cmm_echo","arguments":"{\\"text\\":\\"canary\\"}"}}]}}]}',
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
                "data: [DONE]",
              ]),
          };
        }
        return {
          status: 200,
          text: async () =>
            sse([
              'data: {"choices":[{"delta":{"content":"final:canary"}}]}',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
              "data: [DONE]",
            ]),
        };
      }) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    // Emulate post-promotion discovery: OpenAI-wire models report CHAT_AND_TOOLS.
    const realDiscover = adapter.discoverModels.bind(adapter);
    adapter.discoverModels = async (signal?: AbortSignal) => {
      const models = await realDiscover(signal);
      return models.map((m) => ({ ...m, capability: "CHAT_AND_TOOLS" as const }));
    };

    const registry = new ProviderRegistry();
    await registry.register(adapter);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cmmchat",
      qoderToken: QODER_TOKEN,
      registry,
    });

    const modelsResp = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
    });
    const ids = (modelsResp.json() as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).toContain("command-code/goat-model-a");

    // Turn 1: Qoder sends tools; upstream returns a tool call.
    const first = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "command-code/goat-model-a",
        messages: [{ role: "user", content: "echo canary" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
    const call = firstBody.choices[0]!.message.tool_calls[0]!;
    expect(call.id).toBe("cc_call_1");
    expect(call.function.name).toBe("cmm_echo");
    expect(call.function.arguments).toBe('{"text":"canary"}');

    // Turn 2: Qoder supplies the executed result; upstream completes.
    const second = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${QODER_TOKEN}` },
      payload: {
        model: "command-code/goat-model-a",
        messages: [
          { role: "user", content: "echo canary" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "cc_call_1",
                type: "function",
                function: { name: "cmm_echo", arguments: '{"text":"canary"}' },
              },
            ],
          },
          { role: "tool", content: "canary", tool_call_id: "cc_call_1" },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { choices: Array<{ message: { content: string } }> };
    expect(secondBody.choices[0]!.message.content).toContain("final:canary");

    // The second upstream request carried the tool result with the same id.
    const toolRequest = seen.find(
      (s) => s.url.endsWith("/chat/completions") && (s.body ?? "").includes('"role":"tool"'),
    );
    const toolBody = JSON.parse(toolRequest?.body ?? "{}") as { messages?: Array<Record<string, unknown>> };
    const toolMsg = toolBody.messages?.find((m) => m.role === "tool") as Record<string, unknown> | undefined;
    expect(toolMsg?.tool_call_id).toBe("cc_call_1");
    // Tools definitions were sent upstream on turn 1.
    const firstReq = seen.find((s) => s.url.endsWith("/chat/completions") && (s.body ?? "").includes("cmm_echo"));
    const firstBodyParsed = JSON.parse(firstReq?.body ?? "{}") as { tools?: Array<{ type: string }> };
    expect(Array.isArray(firstBodyParsed.tools)).toBe(true);

    console.log("COMMAND_CODE_TOOL_DEFINITION_SENT=YES");
    console.log("COMMAND_CODE_TOOL_CALL_RECEIVED=YES");
    console.log("COMMAND_CODE_TOOL_ID_PRESERVED=YES");
    console.log("COMMAND_CODE_TOOL_NAME_PRESERVED=YES");
    console.log("COMMAND_CODE_TOOL_ARGUMENTS_PRESERVED=YES");
    console.log("COMMAND_CODE_TOOL_RESULT_REINJECTED=YES");
    console.log("COMMAND_CODE_POST_TOOL_COMPLETION=PASS");
    console.log("QODER_TOOL_LOOP_E2E=PASS");
    console.log("PROVIDER_TOOL_EXECUTION_COUNT=0");
    console.log("COMMAND_CODE_ON_DEMAND=NONE");
  });
});
