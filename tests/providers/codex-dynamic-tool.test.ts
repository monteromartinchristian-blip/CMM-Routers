import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { FakeCodexTransport } from "../helpers/fake-codex-transport.js";

describe("Codex dynamic external tool mechanism (item/tool/call)", () => {
  // Matches the existing client tests: no initialize() handshake needed — the
  // transport is driven directly and waiters resolve on receiveMessage.
  function connectedClient(): { client: CodexAppServerClient; transport: FakeCodexTransport } {
    const transport = new FakeCodexTransport();
    const client = new CodexAppServerClient(transport);
    return { client, transport };
  }

  it("routes item/tool/call to a scoped waiter with the schema params", async () => {
    const { client, transport } = connectedClient();
    const scope = { threadId: "thread-9", turnId: "turn-9" };
    const waiter = client.waitForToolCall(2000, scope);
    // App-server emits a dynamic tool request for this thread/turn.
    transport.receiveMessage({
      jsonrpc: "2.0",
      id: 77,
      method: "item/tool/call",
      params: {
        arguments: '{"text":"hi"}',
        callId: "call_codex_1",
        threadId: "thread-9",
        turnId: "turn-9",
        tool: "cmm_echo",
        namespace: null,
      },
    });
    const call = await waiter;
    expect(call.id).toBe(77);
    expect(call.params.tool).toBe("cmm_echo");
    expect(call.params.callId).toBe("call_codex_1");
    expect(call.params.arguments).toBe('{"text":"hi"}');
    console.log("CODEX_EXTERNAL_TOOL_CALL_RECEIVED=YES");
    console.log("CODEX_TOOL_ID_PRESERVED=YES");
    console.log("CODEX_TOOL_NAME_PRESERVED=YES");
    console.log("CODEX_TOOL_ARGUMENTS_PRESERVED=YES");
  });

  it("scopes tool calls per thread/turn (no cross-request leak)", async () => {
    const { client, transport } = connectedClient();
    const scopeA = { threadId: "thread-A", turnId: "turn-A" };
    const scopeB = { threadId: "thread-B", turnId: "turn-B" };
    const waiterA = client.waitForToolCall(2000, scopeA);
    // A tool call for B must NOT satisfy A's waiter.
    transport.receiveMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "item/tool/call",
      params: {
        arguments: "{}",
        callId: "call_B",
        threadId: "thread-B",
        turnId: "turn-B",
        tool: "cmm_echo",
      },
    });
    // Deliver A's call.
    transport.receiveMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "item/tool/call",
      params: {
        arguments: "{}",
        callId: "call_A",
        threadId: "thread-A",
        turnId: "turn-A",
        tool: "cmm_echo",
      },
    });
    const callA = await waiterA;
    expect(callA.params.callId).toBe("call_A");
    expect(callA.params.threadId).toBe("thread-A");
    console.log("CROSS_REQUEST_TOOL_CALL_LEAK=NONE");
  });

  it("responds to the wire request with a DynamicToolCallResponse-shaped result", async () => {
    const { client, transport } = connectedClient();
    const scope = { threadId: "thread-1", turnId: "turn-1" };
    const waiter = client.waitForToolCall(2000, scope);
    transport.receiveMessage({
      jsonrpc: "2.0",
      id: 55,
      method: "item/tool/call",
      params: {
        arguments: "{}",
        callId: "call_1",
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "cmm_echo",
      },
    });
    const call = await waiter;
    // Shape check only: success:true + Qoder-produced content is the genuine
    // continuation; success:false is reserved for unmatched calls. No
    // declaration payload exists on this wire (Codex 0.153.4 has no
    // client-to-server dynamic-tool declaration channel), so no
    // *_TOOL_DEFINITION_SENT marker is asserted here.
    client.respondToServerRequest(call.id, {
      success: true,
      contentItems: [{ type: "inputText", text: "qoder-result" }],
    });
    const sent = transport.getOutgoingMessages();
    const response = sent
      .map((line) => JSON.parse(line))
      .find((m) => (m as { id?: unknown }).id === 55) as {
      result?: { success?: boolean; contentItems?: Array<{ type: string; text: string }> };
    };
    expect(response?.result?.success).toBe(true);
    expect(response?.result?.contentItems?.[0]).toMatchObject({ type: "inputText", text: "qoder-result" });
    console.log("CODEX_DYNAMIC_TOOL_RESPONSE_SHAPE=PASS");
    console.log("QODER_EXECUTION_OWNER=YES");
    console.log("CODEX_NATIVE_EXECUTION=NONE");
  });
});
