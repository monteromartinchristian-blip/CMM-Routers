import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function sse(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}

describe("Command Code strict continuation (RED: assistant tool_calls dropped)", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-strict-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("second upstream request carries assistant tool_calls + tool result", async () => {
    const seenBodies: unknown[] = [];
    let chatCalls = 0;
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (url: string, init: { body?: string }) => {
        seenBodies.push(JSON.parse(String(init?.body)));
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            status: 200,
            text: async () =>
              sse([
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-strict-1","type":"function","function":{"name":"cmm_echo","arguments":"{\\"text\\":\\"canary\\"}"}}]}}]}',
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
                "data: [DONE]",
              ]),
          };
        }
        const body = seenBodies[seenBodies.length - 1] as { messages: Array<Record<string, unknown>> };
        const assistant = body.messages.find(
          (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
        );
        const tool = body.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "call-strict-1",
        );
        if (!assistant || !tool) {
          return { status: 400, text: async () => "missing assistant tool_calls continuation" };
        }
        return {
          status: 200,
          text: async () =>
            sse([
              'data: {"choices":[{"delta":{"content":"final:canary"}}]}',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
              "data: [DONE]",
            ]),
        };
      }) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });

    const base = {
      model: { id: "command-code/m", provider: "command-code", upstreamModel: "m", displayName: "m", capability: "CHAT_AND_TOOLS" },
      tools: [CMM_ECHO_TOOL],
      stream: false,
    };
    for await (const _ of adapter.run(
      { ...base, requestId: "s1", messages: [{ role: "user", content: "echo canary" }] } as RouterRequest,
      new AbortController().signal,
    )) {
      // drain turn 1
    }
    const events: unknown[] = [];
    for await (const event of adapter.run(
      {
        ...base,
        requestId: "s2",
        messages: [
          { role: "user", content: "echo canary" },
          { role: "assistant", content: null, toolCalls: [{ id: "call-strict-1", type: "function", function: { name: "cmm_echo", arguments: '{"text":"canary"}' } }] },
          { role: "tool", content: "canary", toolCallId: "call-strict-1" },
        ],
      } as RouterRequest,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    const text = (events as Array<{ type: string; text?: string }>)
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text ?? "")
      .join("");
    expect(text).toContain("final:canary");
    console.log("COMMAND_CODE_ASSISTANT_TOOL_HISTORY_PRESERVED=YES");
  });
});
