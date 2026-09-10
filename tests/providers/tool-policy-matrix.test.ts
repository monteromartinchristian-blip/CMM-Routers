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
  return (await chatResponse(id, extra)).statusCode;
}

async function responsesStatus(
  id: ProviderId,
  extra: Record<string, unknown>,
): Promise<number> {
  return (await responsesResponse(id, extra)).statusCode;
}

async function chatResponse(id: ProviderId, extra: Record<string, unknown>) {
  const server = await serverFor(id);
  return server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer q" },
    payload: { model: `${id}/m`, messages: [{ role: "user", content: "hi" }], tools: TOOLS, ...extra },
  });
}

async function responsesResponse(id: ProviderId, extra: Record<string, unknown>) {
  const server = await serverFor(id);
  return server.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer q" },
    payload: { model: `${id}/m`, input: "hi", tools: TOOLS, ...extra },
  });
}

function errorType(body: string): string {
  return JSON.parse(body).error.type as string;
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

  it("accepts only the exactly-representable constraints for Claude and Google", async () => {
    for (const id of ["claude", "google"] as ProviderId[]) {
      expect(await chatStatus(id, { tool_choice: "auto" })).toBe(200);
      expect(await chatStatus(id, {})).toBe(200);
    }
    expect(seen.length).toBe(4);
  });

  it("CLAUDE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION", async () => {
    // Claude Agent SDK 0.3.266 exposes NO provider-side parallel-tool control.
    // Absence of parallel_tool_calls is therefore faithful, but an explicit
    // true OR false is a caller constraint the provider cannot represent.
    // The Router's own single-parked-call handoff limit is a Router safety
    // rule, not an upstream representation, so it cannot justify acceptance.
    expect(await chatStatus("claude", { parallel_tool_calls: false })).toBe(400);
    expect(await chatStatus("claude", { parallel_tool_calls: true })).toBe(400);
    expect(await responsesStatus("claude", { parallel_tool_calls: false })).toBe(400);
    expect(await responsesStatus("claude", { parallel_tool_calls: true })).toBe(400);
    expect(errorType((await chatResponse("claude", { parallel_tool_calls: false })).body)).toBe(
      "unsupported_capability",
    );
    expect(errorType((await responsesResponse("claude", { parallel_tool_calls: true })).body)).toBe(
      "unsupported_capability",
    );
    expect(await chatStatus("claude", { tool_choice: "auto" })).toBe(200);
    expect(await responsesStatus("claude", { tool_choice: "auto" })).toBe(200);
    expect(seen.length).toBe(2);
    console.log("CLAUDE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS");
  });

  it("GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION", async () => {
    // agy 1.2.0 exposes no parallel-execution flag (`agy --help`), so it gets
    // the same literal policy as Claude.
    expect(await chatStatus("google", { parallel_tool_calls: false })).toBe(400);
    expect(await chatStatus("google", { parallel_tool_calls: true })).toBe(400);
    expect(await responsesStatus("google", { parallel_tool_calls: false })).toBe(400);
    expect(await responsesStatus("google", { parallel_tool_calls: true })).toBe(400);
    expect(errorType((await chatResponse("google", { parallel_tool_calls: false })).body)).toBe(
      "unsupported_capability",
    );
    expect(errorType((await responsesResponse("google", { parallel_tool_calls: false })).body)).toBe(
      "unsupported_capability",
    );
    expect(await chatStatus("google", { tool_choice: "auto" })).toBe(200);
    expect(await responsesStatus("google", { tool_choice: "auto" })).toBe(200);
    expect(seen.length).toBe(2);
    console.log("GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS");
  });

  it("normalizes each surface's own named-function wire shape before provider policy", async () => {
    // Each surface gets ITS OWN canonical shape. A wire-shape parse failure
    // would surface as invalid_request; unsupported_capability proves the
    // named choice was understood and then refused faithfully.
    for (const id of ["claude", "google"] as ProviderId[]) {
      expect(
        errorType(
          (await chatResponse(id, { tool_choice: { type: "function", function: { name: "t" } } }))
            .body,
        ),
      ).toBe("unsupported_capability");
      expect(
        errorType(
          (await responsesResponse(id, { tool_choice: { type: "function", name: "t" } })).body,
        ),
      ).toBe("unsupported_capability");
    }
    // Command Code represents the canonical named choice on both wires.
    seen.length = 0;
    expect(
      await chatStatus("command-code", {
        tool_choice: { type: "function", function: { name: "t" } },
      }),
    ).toBe(200);
    expect(seen[0]!.toolChoice).toEqual({ kind: "named", name: "t" });
    expect(
      await responsesStatus("command-code", { tool_choice: { type: "function", name: "t" } }),
    ).toBe(200);
    expect(seen[1]!.toolChoice).toEqual({ kind: "named", name: "t" });
    console.log("CHAT_RESPONSES_TOOL_POLICY_WIRE_NORMALIZATION=PASS");
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
    // The Router request now carries the internal normalized policy.
    expect(seen[0]!.toolChoice).toEqual({ kind: "required" });
    expect(seen[0]!.parallelToolCalls).toBe(false);
    console.log("COMMAND_CODE_OPENAI_TOOL_CHOICE_POLICY=PASS");
    console.log("COMMAND_CODE_OPENAI_PARALLEL_POLICY=PASS");
  });

  it("enforces the identical policy on /v1/responses", async () => {
    // Each surface is exercised with its OWN canonical wire shape; a single
    // shared input cannot prove per-API normalization.
    const cases: Array<[ProviderId, Record<string, unknown>, Record<string, unknown>]> = [
      ["claude", { tool_choice: "required" }, { tool_choice: "required" }],
      ["claude", { parallel_tool_calls: true }, { parallel_tool_calls: true }],
      ["claude", { tool_choice: "auto" }, { tool_choice: "auto" }],
      ["google", { tool_choice: "none" }, { tool_choice: "none" }],
      ["google", { parallel_tool_calls: false }, { parallel_tool_calls: false }],
      ["chatgpt", { tool_choice: "required" }, { tool_choice: "required" }],
      ["chatgpt", { parallel_tool_calls: false }, { parallel_tool_calls: false }],
      [
        "chatgpt",
        { tool_choice: "auto", parallel_tool_calls: true },
        { tool_choice: "auto", parallel_tool_calls: true },
      ],
      [
        "command-code",
        { tool_choice: "required", parallel_tool_calls: false },
        { tool_choice: "required", parallel_tool_calls: false },
      ],
      [
        "claude",
        { tool_choice: { type: "function", function: { name: "t" } } },
        { tool_choice: { type: "function", name: "t" } },
      ],
      [
        "command-code",
        { tool_choice: { type: "function", function: { name: "t" } } },
        { tool_choice: { type: "function", name: "t" } },
      ],
    ];
    for (const [id, chatExtra, responsesExtra] of cases) {
      const chat = await chatStatus(id, chatExtra);
      const responses = await responsesStatus(id, responsesExtra);
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
    const status3 = await chatStatus("google", { parallel_tool_calls: false });
    expect(status3).toBe(400);
    expect(seen.length).toBe(0);
    console.log("SILENT_TOOL_CHOICE_DROP=NONE");
    console.log("SILENT_PARALLEL_TOOL_POLICY_DROP=NONE");
  });
});
