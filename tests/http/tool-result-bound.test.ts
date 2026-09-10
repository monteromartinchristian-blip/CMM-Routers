import { describe, expect, it, beforeEach } from "vitest";
import { Duplex } from "node:stream";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { MAX_TOOL_RESULT_BYTES, assertToolResultsWithinBound } from "../../src/core/tool-result-bound.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/** Minimal app-server double: replies to handshake and completes a text turn. */
function buildCodexTransport(seen: unknown[]): Duplex {
  const transport: Duplex = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const msg = JSON.parse(chunk.toString()) as { id?: unknown; method?: string };
      seen.push(msg);
      const push = (m: object) => transport.push(`${JSON.stringify(m)}\n`);
      if (msg.method === "initialize") push({ jsonrpc: "2.0", id: msg.id, result: {} });
      else if (msg.method === "model/list")
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { data: [{ id: "test-model", model: "test-model", displayName: "Test Model" }] },
        });
      else if (msg.method === "thread/start")
        push({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } });
      else if (msg.method === "thread/inject_items")
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      else if (msg.method === "turn/start") {
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
        });
        setTimeout(() => {
          push({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: { delta: "ok", itemId: "i", threadId: "thread-1", turnId: "turn-1" },
          });
          push({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
          });
        }, 5);
      }
      callback();
    },
  });
  return transport;
}

describe("tool-result size bound at the HTTP boundary", () => {
  const bearerSecret = "test-secret-123";
  const qoderSecret = "qoder-secret-456";
  let registry: ProviderRegistry;
  let transportCreated: number;
  let baselineTransportCreated: number;
  let seen: unknown[];

  beforeEach(async () => {
    registry = new ProviderRegistry();
    transportCreated = 0;
    seen = [];
    let transport: Duplex | undefined;
    const adapter = new CodexAdapter({
      transportFactory: () => {
        transportCreated += 1;
        transport ??= buildCodexTransport(seen);
        return transport;
      },
    });
    await registry.register(adapter);
    await registry.refresh();
    // refresh() performs discovery, which starts the transport once.
    baselineTransportCreated = transportCreated;
    seen.length = 0;
  });

  async function postToolResult(content: string): Promise<{ status: number; body: string }> {
    const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret, qoderToken: qoderSecret, registry });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${qoderSecret}` },
      payload: {
        model: "chatgpt/test-model",
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "cmm_chatgpt_1", type: "function", function: { name: "cmm_echo", arguments: '{"text":"x"}' } },
            ],
          },
          { role: "tool", tool_call_id: "cmm_chatgpt_1", content },
        ],
        tools: [CMM_ECHO_TOOL],
      },
    });
    return { status: res.statusCode, body: res.body };
  }

  it("rejects an oversize tool result before the provider is reached", async () => {
    const { status } = await postToolResult("x".repeat(MAX_TOOL_RESULT_BYTES + 1));
    expect(status).toBe(400);
    expect(transportCreated).toBe(baselineTransportCreated);
    console.log("TOOL_RESULT_SIZE_BOUND_IMPLEMENTED=PASS");
    console.log("OVERSIZE_TOOL_RESULT_REJECTED_BEFORE_PROVIDER=PASS");
  });

  it("permits a tool result exactly at the bound to reach the adapter", async () => {
    const { status, body } = await postToolResult("x".repeat(MAX_TOOL_RESULT_BYTES));
    // The size policy must not reject an at-bound result; any downstream error
    // must be unrelated to the byte limit.
    expect(status).not.toBe(400);
    expect(body).not.toContain("byte limit");
    console.log("TOOL_RESULT_AT_BOUND_ALLOWED=PASS");
  });

  it("bound is exclusive: MAX accepted, MAX+1 refused", () => {
    expect(() =>
      assertToolResultsWithinBound([{ role: "tool", content: "x".repeat(MAX_TOOL_RESULT_BYTES) }]),
    ).not.toThrow();
    expect(() =>
      assertToolResultsWithinBound([
        { role: "tool", content: "x".repeat(MAX_TOOL_RESULT_BYTES + 1) },
      ]),
    ).toThrow(/byte limit/);
  });
});
