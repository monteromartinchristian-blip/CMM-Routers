import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import type { ProviderId } from "../../src/core/model.js";
import type { RouterRequest } from "../../src/core/model.js";

const seen: RouterRequest[] = [];

function captureAdapter(id: ProviderId): ProviderAdapter {
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
    async *run(request) {
      seen.push(request);
      yield { type: "completed", finishReason: "stop" };
    },
    async cancel() {},
  };
}

async function serverFor(id: ProviderId) {
  const registry = new ProviderRegistry();
  await registry.register(captureAdapter(id));
  await registry.refresh();
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: "c",
    qoderToken: "q",
    registry,
  });
}

const TOOLS = [{ type: "function", function: { name: "t", parameters: {} } }];

async function chatStatus(
  id: ProviderId,
  extra: Record<string, unknown>,
): Promise<number> {
  const server = await serverFor(id);
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer q" },
    payload: { model: `${id}/m`, messages: [{ role: "user", content: "hi" }], tools: TOOLS, ...extra },
  });
  return res.statusCode;
}

async function responsesStatus(
  id: ProviderId,
  extra: Record<string, unknown>,
): Promise<number> {
  const server = await serverFor(id);
  const res = await server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer q" },
    payload: { model: `${id}/m`, input: "hi", tools: TOOLS, ...extra },
  });
  return res.statusCode;
}

describe("provider tool_choice / parallel_tool_calls policy", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("rejects unrepresentable constraints for Claude and Google", async () => {
    for (const id of ["claude", "google"] as ProviderId[]) {
      expect(await chatStatus(id, { tool_choice: "required" })).toBe(400);
      expect(await chatStatus(id, { tool_choice: "none" })).toBe(400);
      expect(
        await chatStatus(id, { tool_choice: { type: "function", function: { name: "t" } } }),
      ).toBe(400);
      expect(await chatStatus(id, { parallel_tool_calls: true })).toBe(400);
    }
    expect(seen.length).toBe(0);
    console.log("CLAUDE_TOOL_CHOICE_POLICY=PASS");
    console.log("CLAUDE_PARALLEL_TOOL_POLICY=PASS");
    console.log("ANTIGRAVITY_TOOL_CHOICE_POLICY=PASS");
    console.log("ANTIGRAVITY_PARALLEL_TOOL_POLICY=PASS");
    console.log("CLAUDE_SILENT_TOOL_POLICY_DROP=NONE");
    console.log("ANTIGRAVITY_SILENT_TOOL_POLICY_DROP=NONE");
  });

  it("accepts the exactly-representable constraints for Claude and Google", async () => {
    for (const id of ["claude", "google"] as ProviderId[]) {
      expect(await chatStatus(id, { tool_choice: "auto", parallel_tool_calls: false })).toBe(200);
    }
    expect(seen.length).toBe(2);
  });

  it("preserves the Codex fail-closed policy and Command Code forwarding", async () => {
    expect(await chatStatus("chatgpt", { tool_choice: "required" })).toBe(400);
    expect(await chatStatus("chatgpt", { parallel_tool_calls: false })).toBe(400);
    expect(await chatStatus("chatgpt", { tool_choice: "auto", parallel_tool_calls: true })).toBe(200);
    console.log("CODEX_TOOL_CHOICE_POLICY=PASS");
    console.log("CODEX_PARALLEL_TOOL_POLICY=PASS");

    seen.length = 0;
    expect(
      await chatStatus("command-code", { tool_choice: "required", parallel_tool_calls: false }),
    ).toBe(200);
    expect(seen[0]!.toolChoice).toBe("required");
    expect(seen[0]!.parallelToolCalls).toBe(false);
    console.log("COMMAND_CODE_OPENAI_TOOL_CHOICE_POLICY=PASS");
    console.log("COMMAND_CODE_OPENAI_PARALLEL_POLICY=PASS");
  });

  it("enforces the identical policy on /v1/responses", async () => {
    const cases: Array<[ProviderId, Record<string, unknown>]> = [
      ["claude", { tool_choice: "required" }],
      ["claude", { parallel_tool_calls: true }],
      ["claude", { tool_choice: "auto", parallel_tool_calls: false }],
      ["google", { tool_choice: "none" }],
      ["google", { tool_choice: "auto", parallel_tool_calls: false }],
      ["chatgpt", { tool_choice: "required" }],
      ["chatgpt", { tool_choice: "auto", parallel_tool_calls: true }],
      ["command-code", { tool_choice: "required", parallel_tool_calls: false }],
    ];
    for (const [id, extra] of cases) {
      const chat = await chatStatus(id, extra);
      const responses = await responsesStatus(id, extra);
      expect(responses).toBe(chat);
    }
    console.log("CHAT_RESPONSES_TOOL_POLICY_CONSISTENCY=PASS");
  });

  it("never drops a requested policy silently", async () => {
    // Every rejected case must be an explicit 400, never a 200 with the
    // constraint removed from the provider request.
    seen.length = 0;
    const status = await chatStatus("claude", { tool_choice: "required", parallel_tool_calls: true });
    expect(status).toBe(400);
    expect(seen.length).toBe(0);
    const status2 = await chatStatus("google", { parallel_tool_calls: true });
    expect(status2).toBe(400);
    expect(seen.length).toBe(0);
    console.log("SILENT_TOOL_CHOICE_DROP=NONE");
    console.log("SILENT_PARALLEL_TOOL_POLICY_DROP=NONE");
  });
});
