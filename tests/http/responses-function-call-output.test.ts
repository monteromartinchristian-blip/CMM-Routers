import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function toolAdapter(id: "command-code" | "chatgpt"): ProviderAdapter {
  return {
    id,
    async discoverModels() {
      return [
        {
          id: `${id}/m`,
          provider: id,
          upstreamModel: "m",
          displayName: "m",
          capability: "CHAT_AND_TOOLS",
        },
      ];
    },
    async health() {
      return { status: "ready" };
    },
    async *run() {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-resp-1",
        name: "cmm_echo",
        argumentsDelta: '{"text":"canary"}',
      };
      yield { type: "completed", finishReason: "tool_calls" };
    },
    async cancel() {},
  };
}

describe("Responses canonical function-call I/O", () => {
  it("accepts function_call + function_call_output items and round-trips IDs", async () => {
    const registry = new ProviderRegistry();
    await registry.register(toolAdapter("command-code"));
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "c",
      qoderToken: "q",
      registry,
    });
    const res = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer q" },
      payload: {
        model: "command-code/m",
        input: [
          { role: "user", content: "echo canary" },
          { type: "function_call", call_id: "call-resp-1", name: "cmm_echo", arguments: '{"text":"canary"}' },
          { type: "function_call_output", call_id: "call-resp-1", output: "canary" },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      output: Array<{ type: string; call_id?: string; id?: string; name?: string; arguments?: string }>;
    };
    const call = body.output.find((o) => o.type === "function_call");
    // Exact keys: the call id used for function_call_output is distinct from
    // the output item id. `call_id ?? id` would mask a missing call_id.
    expect(call?.call_id).toBe("call-resp-1");
    expect(typeof call?.id).toBe("string");
    expect(call?.id).not.toBe(call?.call_id);
    expect(call?.name).toBe("cmm_echo");
    console.log("RESPONSES_FUNCTION_CALL_OUTPUT_PARSE=PASS");
    console.log("RESPONSES_FUNCTION_CALL_CALL_ID=PASS");
    console.log("RESPONSES_FUNCTION_CALL_ITEM_ID=PASS");
    console.log("RESPONSES_CALL_ID_DISTINCT_FROM_ITEM_ID=PASS");
    console.log("RESPONSES_FUNCTION_CALL_ID_ROUNDTRIP=PASS");
  });
});
