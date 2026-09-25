import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * Finding F2 — the canonical tool-result status must not leak onto an OpenAI
 * upstream wire as a non-standard field.
 *
 * The two Command Code wires need different translations: Anthropic Messages can
 * represent the outcome as `is_error`, an OpenAI-compatible wire cannot represent
 * it at all, so the canonical status stays internal rather than being invented.
 */

function sse(frames: string[]): string {
  return frames.map((frame) => `data: ${frame}`).join("\n\n") + "\n\n";
}

const TOOL_CONTENT = "TOOL_FAILED_CONTENT_9f3a";

describe("Command Code wire translation is per-protocol", () => {
  let dir: string;
  let ackPath: string;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-wire-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({
        version: 1,
        plan: "GOAT",
        autoTopUpDisabled: true,
        allowOnDemandCredits: false,
      }),
    );
    bodies = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function adapterFor(frames: string[]): CommandCodeAdapter {
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

  function requestFor(upstreamModel: string, status: "success" | "error"): RouterRequest {
    return {
      requestId: `cc-${upstreamModel}-${status}`,
      model: {
        id: `command-code/${upstreamModel}`,
        provider: "command-code",
        upstreamModel,
        displayName: upstreamModel,
        capability: "CHAT_AND_TOOLS",
      },
      messages: [
        { role: "user", content: "echo" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "tu_1", type: "function", function: { name: "cmm_echo", arguments: "{}" } },
          ],
        },
        { role: "tool", content: TOOL_CONTENT, toolCallId: "tu_1", toolResultStatus: status },
      ],
      tools: [],
      stream: true,
    };
  }

  async function drain(adapter: CommandCodeAdapter, request: RouterRequest): Promise<void> {
    for await (const _event of adapter.run(request, new AbortController().signal)) {
      void (_event as RouterEvent);
    }
  }

  it("OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT and content preserved", async () => {
    const adapter = adapterFor([
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    await drain(adapter, requestFor("test-model", "error"));

    expect(bodies.length).toBe(1);
    const serialized = JSON.stringify(bodies[0]);
    // No invented extension on a wire that has no error bit.
    expect(serialized).not.toContain("tool_result_status");
    expect(serialized).not.toContain("is_error");
    // The tool result itself survives byte-identically.
    expect(serialized).toContain(TOOL_CONTENT);
    const messages = bodies[0]!.messages as Array<Record<string, unknown>>;
    const toolMessage = messages.find((message) => message.role === "tool")!;
    expect(toolMessage.content).toBe(TOOL_CONTENT);
    expect(toolMessage.tool_call_id).toBe("tu_1");
    console.log("OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT");
    console.log("OPENAI_UPSTREAM_TOOL_RESULT_CONTENT_PRESERVED=PASS");
  });

  it("ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED on the Anthropic wire", async () => {
    const adapter = adapterFor([
      JSON.stringify({ type: "message_start", message: { usage: {} } }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    await drain(adapter, requestFor("claude-sonnet-4-5", "error"));

    expect(bodies.length).toBe(1);
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).toContain('"is_error":true');
    expect(serialized).toContain(TOOL_CONTENT);
    // The canonical field name never appears on the wire either.
    expect(serialized).not.toContain("tool_result_status");
    console.log("ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED");
  });

  it("a successful tool result stays the protocol default on both wires", async () => {
    const openai = adapterFor([
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    await drain(openai, requestFor("test-model", "success"));
    expect(JSON.stringify(bodies[0])).not.toContain("tool_result_status");

    bodies = [];
    const anthropic = adapterFor([
      JSON.stringify({ type: "message_start", message: { usage: {} } }),
      JSON.stringify({ type: "message_stop" }),
    ]);
    await drain(anthropic, requestFor("claude-sonnet-4-5", "success"));
    expect(JSON.stringify(bodies[0])).not.toContain("is_error");
  });
});
