import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { buildAnthropicRequestBody } from "../../src/providers/command-code/client.js";
import { toolResultStatusSuffix } from "../../src/core/tool-result-status.js";

/**
 * Finding P2 — a client-reported tool failure must survive the canonical model.
 *
 * `tool_result.is_error` was parsed by the Anthropic wire type and then dropped,
 * so a failed tool execution continued with no canonical indication that it
 * failed. The canonical message model now carries a generic outcome status.
 */

const CMMCHAT_TOKEN = "status-cmmchat-secret";
const CODE_TOKEN = "status-code-secret";
const MODEL = "command-code/status-model";
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

async function continueWith(
  server: ReturnType<typeof buildServer>,
  block: Record<string, unknown>,
) {
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
          content: [{ type: "tool_use", id: "tu_1", name: "cmm_echo", input: { text: "a" } }],
        },
        { role: "user", content: [block] },
      ],
    },
  });
  return response;
}

describe("canonical tool-result status", () => {
  it("TOOL_RESULT_ERROR_STATUS_PRESERVED: is_error true reaches the canonical model", async () => {
    const { server, provider } = await harness();
    const response = await continueWith(server, {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "boom",
      is_error: true,
    });
    expect(response.statusCode).toBe(200);
    const toolMessage = provider.turns[0]!.toolResults[0]!;
    expect(toolMessage.status).toBe("error");
    console.log("TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS");
  });

  it("TOOL_RESULT_SUCCESS_STATUS_PRESERVED: absent/false is an explicit success", async () => {
    const { server, provider } = await harness();
    await continueWith(server, { type: "tool_result", tool_use_id: "tu_1", content: "fine" });
    expect(provider.turns[0]!.toolResults[0]!.status).toBe("success");

    const second = await harness();
    await continueWith(second.server, {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "fine",
      is_error: false,
    });
    expect(second.provider.turns[0]!.toolResults[0]!.status).toBe("success");
    console.log("TOOL_RESULT_SUCCESS_STATUS_PRESERVED=PASS");
  });

  it("TOOL_RESULT_STATUS_HARNESS_AGNOSTIC: the canonical field lives in core", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(import.meta.dirname, "../../src/core/model.ts"), "utf-8");
    expect(source).toContain("toolResultStatus");
    const lower = source.toLowerCase();
    for (const brand of ["qoder", "hermes", "codex-client", "cline", "roo", "deepseek"]) {
      expect(lower, `core model must not name ${brand}`).not.toContain(brand);
    }
    console.log("TOOL_RESULT_STATUS_HARNESS_AGNOSTIC=PASS");
  });

  it("the Anthropic upstream wire preserves the error bit", () => {
    // The command-code adapter converts canonical messages into this wire shape,
    // carrying tool_result_status alongside tool_call_id.
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tu_1", type: "function", function: { name: "cmm_echo", arguments: "{}" } }],
      },
      { role: "tool", content: "boom", tool_call_id: "tu_1", tool_result_status: "error" },
      { role: "tool", content: "fine", tool_call_id: "tu_2", tool_result_status: "success" },
    ];
    const body = buildAnthropicRequestBody("m", messages as never);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('"is_error":true');
    // Success is the protocol default and is not restated.
    expect(serialized.match(/"is_error"/g)?.length).toBe(1);
    console.log("ANTHROPIC_WIRE_ERROR_BIT_PRESERVED=PASS");
  });

  it("text-flattening bridges mark the outcome instead of erasing it", () => {
    expect(toolResultStatusSuffix("error")).toBe(" error");
    expect(toolResultStatusSuffix("success")).toBe("");
    expect(toolResultStatusSuffix(undefined)).toBe("");
  });
});
