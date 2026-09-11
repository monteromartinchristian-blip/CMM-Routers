import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function sse(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}

describe("Command Code fragmented tool stream", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-frag-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function adapterFor(frames: string[]): CommandCodeAdapter {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async () => ({
        status: 200,
        text: async () => sse(frames),
      })) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  function baseReq(requestId: string): RouterRequest {
    return {
      requestId,
      model: { id: "command-code/m", provider: "command-code", upstreamModel: "m", displayName: "m", capability: "CHAT_AND_TOOLS" },
      messages: [{ role: "user", content: "hi" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
    };
  }

  async function toolDeltas(adapter: CommandCodeAdapter, id: string): Promise<RouterEvent[]> {
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(baseReq(id), new AbortController().signal)) {
      events.push(event);
    }
    return events.filter((e) => e.type === "tool_call_delta");
  }

  function toolCall(index: number, extra: Record<string, unknown>): unknown {
    return {
      choices: [{ delta: { tool_calls: [{ index, ...extra }] }, finish_reason: null }],
    };
  }

  it("assembles one fragmented call (id/name only in first chunk)", async () => {
    const adapter = adapterFor([
      frame(toolCall(0, { id: "call-frag-1", type: "function", function: { name: "cmm_echo", arguments: '{"text"' } })),
      frame(toolCall(0, { function: { arguments: ':"canary"' } })),
      frame(toolCall(0, { function: { arguments: "}" } })),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]",
    ]);
    const deltas = (await toolDeltas(adapter, "frag-1")) as Array<{ id: string; index: number; name?: string; argumentsDelta?: string }>;
    const byId = new Map<string, typeof deltas>();
    for (const d of deltas) {
      const list = byId.get(d.id) ?? [];
      list.push(d);
      byId.set(d.id, list);
    }
    expect(byId.size).toBe(1);
    const parts = byId.get("call-frag-1")!;
    expect(parts[0]!.index).toBe(0);
    expect(parts.map((p) => p.argumentsDelta ?? "").join("")).toBe('{"text":"canary"}');
    expect(parts[0]!.name).toBe("cmm_echo");
    console.log("COMMAND_CODE_FRAGMENTED_TOOL_CALL_ASSEMBLY=PASS");
  });

  it("assembles two parallel fragmented calls with interleaved fragments", async () => {
    const adapter = adapterFor([
      frame(toolCall(0, { id: "call-p-0", type: "function", function: { name: "cmm_echo", arguments: '{"t' } })),
      frame(toolCall(1, { id: "call-p-1", type: "function", function: { name: "cmm_echo", arguments: '{"t' } })),
      frame(toolCall(0, { function: { arguments: 'ext":"a"' } })),
      frame(toolCall(1, { function: { arguments: 'ext":"b"' } })),
      frame(toolCall(0, { function: { arguments: "}" } })),
      frame(toolCall(1, { function: { arguments: "}" } })),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]",
    ]);
    const deltas = (await toolDeltas(adapter, "frag-2")) as Array<{ id: string; index: number; argumentsDelta?: string }>;
    const assembled = new Map<string, string>();
    const indexes = new Map<string, number>();
    for (const d of deltas) {
      assembled.set(d.id, (assembled.get(d.id) ?? "") + (d.argumentsDelta ?? ""));
      indexes.set(d.id, d.index);
    }
    expect(assembled.get("call-p-0")).toBe('{"text":"a"}');
    expect(assembled.get("call-p-1")).toBe('{"text":"b"}');
    expect(indexes.get("call-p-0")).toBe(0);
    expect(indexes.get("call-p-1")).toBe(1);
    console.log("COMMAND_CODE_PARALLEL_TOOL_CALL_ASSEMBLY=PASS");
  });

  it("preserves upstream index (no synthesized reindexing)", async () => {
    const adapter = adapterFor([
      frame(toolCall(3, { id: "call-idx-3", type: "function", function: { name: "cmm_echo", arguments: "{}" } })),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]",
    ]);
    const deltas = (await toolDeltas(adapter, "frag-3")) as Array<{ id: string; index: number }>;
    expect(deltas[0]!.index).toBe(3);
    expect(deltas[0]!.id).toBe("call-idx-3");
    console.log("COMMAND_CODE_UPSTREAM_TOOL_INDEX_PRESERVED=YES");
  });
});
