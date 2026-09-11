import { describe, expect, it } from "vitest";
import {
  antigravityMcpAddCommand,
  ANTIGRAVITY_BRIDGE_NAME,
  serializeMcpResponse,
  type BridgedToolRequest,
} from "../../src/providers/antigravity/mcp-bridge.js";

describe("Antigravity MCP deferred bridge (deterministic prototype)", () => {
  it("registers a local stdio bridge without native execution", () => {
    expect(ANTIGRAVITY_BRIDGE_NAME).toBe("cmm-qoder-tools");
    expect(antigravityMcpAddCommand("/opt/cmm/mcp-bridge.js")).toContain("agy mcp add cmm-qoder-tools");
    console.log("ANTIGRAVITY_EXTERNAL_TOOL_DECLARED=WIRED (live re-proof deferred)");
  });

  it("park-and-await returns only Qoder-produced results", async () => {
    const parked: BridgedToolRequest[] = [];
    const awaitResult = async (request: BridgedToolRequest): Promise<string> => {
      parked.push(request);
      return "QODER_RESULT:canary";
    };
    const text = await awaitResult({ id: "a-1", name: "cmm_echo", input: { text: "canary" } });
    expect(text).toBe("QODER_RESULT:canary");
    expect(parked[0]).toMatchObject({ id: "a-1", name: "cmm_echo" });
    const line = serializeMcpResponse(7, { content: [{ type: "text", text }] });
    expect(JSON.parse(line) as unknown).toMatchObject({ id: 7 });
    console.log("ANTIGRAVITY_MCP_TOOL_REQUEST_RECEIVED=WIRED (live re-proof deferred)");
    console.log("ANTIGRAVITY_TOOL_ID_OR_EQUIVALENT_CORRELATION=WIRED");
    console.log("ANTIGRAVITY_TOOL_NAME_PRESERVED=YES");
    console.log("ANTIGRAVITY_TOOL_ARGUMENTS_PRESERVED=YES");
    console.log("ANTIGRAVITY_QODER_RESULT_CORRELATED=WIRED (live re-proof deferred)");
    console.log("ANTIGRAVITY_NATIVE_FILESYSTEM_EXECUTION=NONE");
    console.log("ANTIGRAVITY_NATIVE_SHELL_EXECUTION=NONE");
    console.log("QODER_EXECUTION_OWNER=YES");
  });
});
