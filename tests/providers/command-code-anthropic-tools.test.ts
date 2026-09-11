import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function sse(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
}

const ANTHROPIC_TOOL_STREAM: Array<Record<string, unknown>> = [
  { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "cmm_echo" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"text":' },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"canary"}' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

describe("Command Code Anthropic wire: tools", () => {
  let dir: string;
  let ackPath: string;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-anthropic-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
    bodies = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function adapterFor(
    frames: Array<Record<string, unknown>>,
  ): CommandCodeAdapter {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (_url: string, init: { body?: string }) => {
        if (typeof init?.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return { status: 200, text: async () => sse(frames) };
      }) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  function anthropicRequest(
    requestId: string,
    messages: RouterRequest["messages"],
  ): RouterRequest {
    return {
      requestId,
      model: {
        id: "command-code/claude-sonnet-4-5",
        provider: "command-code",
        upstreamModel: "claude-sonnet-4-5",
        displayName: "claude-sonnet-4-5",
        capability: "CHAT_AND_TOOLS",
      },
      messages,
      tools: [CMM_ECHO_TOOL],
      stream: true,
    };
  }

  async function drain(adapter: CommandCodeAdapter, request: RouterRequest): Promise<RouterEvent[]> {
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal)) events.push(event);
    return events;
  }

  it("declares Qoder tools in Anthropic shape and preserves ids on continuation", async () => {
    const adapter = adapterFor([
      { type: "message_start", message: { usage: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_stop" },
    ]);
    await drain(
      adapter,
      anthropicRequest("a1", [
        { role: "user", content: "echo" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "toolu_1", type: "function", function: { name: "cmm_echo", arguments: '{"text":"canary"}' } },
          ],
        },
        { role: "tool", content: "canary", toolCallId: "toolu_1" },
      ]),
    );

    const body = bodies[0]!;
    expect(body.tools).toEqual([
      {
        name: "cmm_echo",
        description: "Return the supplied text unchanged.",
        input_schema: CMM_ECHO_TOOL.function.parameters,
      },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toMatchObject([
      { type: "tool_use", id: "toolu_1", name: "cmm_echo", input: { text: "canary" } },
    ]);
    const toolResult = messages.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_result"),
    )!;
    expect(toolResult.content).toMatchObject([
      { type: "tool_result", tool_use_id: "toolu_1", content: "canary" },
    ]);
    console.log("COMMAND_CODE_ANTHROPIC_TOOL_DECLARATION=PASS");
    console.log("COMMAND_CODE_ANTHROPIC_TOOL_RESULT_CONTINUATION=PASS");
  });

  it("parses tool_use and streaming input_json_delta into a Qoder tool call", async () => {
    const adapter = adapterFor(ANTHROPIC_TOOL_STREAM);
    const events = await drain(
      adapter,
      anthropicRequest("a2", [{ role: "user", content: "echo canary" }]),
    );
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]).toMatchObject({ id: "toolu_1", name: "cmm_echo", index: 0 });
    const assembled = deltas.map((d) => (d as { argumentsDelta: string }).argumentsDelta).join("");
    expect(assembled).toBe('{"text":"canary"}');
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toMatchObject({ finishReason: "tool_calls" });
    // No execution on the Router side.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    console.log("COMMAND_CODE_ANTHROPIC_TOOL_USE_PARSE=PASS");
    console.log("COMMAND_CODE_ANTHROPIC_STREAMING_ARGUMENTS=PASS");
    console.log("COMMAND_CODE_NATIVE_TOOL_EXECUTION=NONE");
  });

  it("fails closed on malformed complete tool arguments before any upstream request", async () => {
    const adapter = adapterFor([]);
    const events = await drain(
      adapter,
      anthropicRequest("a3", [
        { role: "user", content: "echo" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "toolu_bad", type: "function", function: { name: "cmm_echo", arguments: "{not json" } },
          ],
        },
        { role: "tool", content: "x", toolCallId: "toolu_bad" },
      ]),
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { error: { code: string } }).error.code).toBe("provider_protocol_error");
    expect(bodies.length).toBe(0);
    console.log("MALFORMED_COMPLETE_TOOL_ARGUMENTS_FAIL_CLOSED=PASS");
  });

  it("advertises Anthropic-wire models as CHAT_AND_TOOLS", async () => {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async () => ({
        status: 200,
        text: async () =>
          JSON.stringify({ data: [{ id: "claude-sonnet-4-5", display_name: "Sonnet 4.5" }] }),
      })) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const models = await adapter.discoverModels();
    expect(models[0]!.capability).toBe("CHAT_AND_TOOLS");
    console.log("COMMAND_CODE_ANTHROPIC_CHAT_AND_TOOLS=PASS");
  });
});
