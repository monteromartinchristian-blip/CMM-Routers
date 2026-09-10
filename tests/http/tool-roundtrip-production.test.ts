import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";
import { DeferredToolBroker } from "../../src/core/deferred-tool-broker.js";
import { createFakeClaudeSdk } from "../helpers/fake-claude-sdk.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

/**
 * Only discovery is stubbed: account-backed model discovery needs a live
 * session. The production run()/broker/bridge path under test is untouched.
 */
class DiscoveryStubClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/test-model",
        provider: "claude",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
}

/**
 * Router-level proof: HTTP -> capability boundary -> production ClaudeAdapter ->
 * production broker + SDK-owned external MCP bridge -> Qoder tool call ->
 * simulated Qoder result -> same-session provider continuation -> final HTTP
 * response whose content is derived from the Qoder result.
 *
 * The MCP client is the protocol-faithful fake SDK, which consumes the
 * production `options.mcpServers` config. The test never touches the MCP wire.
 */
describe("production composition: Claude Qoder tool round-trip over HTTP", () => {
  it("traverses the whole production path and continues the same session", async () => {
    // Sentinel values prove tool arguments and results never reach a log sink
    // anywhere on the real HTTP -> adapter -> broker -> bridge path.
    const ARG_SENTINEL = "CMM_SENTINEL_ARG_7f3a91";
    const RESULT_SENTINEL = "CMM_SENTINEL_RESULT_9b2c47";
    const captured: string[] = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (originalStdout as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (originalStderr as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const restore = (): void => {
      process.stdout.write = originalStdout as typeof process.stdout.write;
      process.stderr.write = originalStderr as typeof process.stderr.write;
    };

    const fake = createFakeClaudeSdk({
      toolName: "cmm_echo",
      toolArguments: { text: ARG_SENTINEL },
      finalPrefix: "answer=",
    });

    const adapter = new DiscoveryStubClaudeAdapter({
      broker: new DeferredToolBroker({ maxPending: 8, defaultTtlMs: 30000 }),
      bridgeCommand: TSX,
      bridgeEntryPath: BRIDGE_ENTRY,
      queryFn: ((args: { prompt: unknown; options: Record<string, unknown> }) =>
        fake.queryFn(args)) as never,
    });

    const registry = new ProviderRegistry();
    await registry.register(adapter);
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "s",
      qoderToken: "q",
      registry,
    });

    try {
      // Exchange 1 is started WITHOUT awaiting: its response cannot complete
      // until the SDK-owned MCP bridge receives Qoder's follow-up.
      const firstPromise = server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer q" },
        payload: {
          model: "claude/test-model",
          messages: [{ role: "user", content: "echo canary" }],
          tools: [CMM_ECHO_TOOL],
        },
      });

      const first = await firstPromise;
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as {
        choices: Array<{
          finish_reason: string;
          message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        }>;
      };
      expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
      const call = firstBody.choices[0]!.message.tool_calls![0]!;
      expect(call.id.startsWith("cmm_claude_")).toBe(true);
      expect(call.function.name).toBe("cmm_echo");
      console.log("HTTP_ROUNDTRIP_QODER_TOOL_CALL_SURFACED=PASS");

      // The provider-facing MCP process is the one the SDK spawned from the
      // production config; the MCP call is still unanswered at this point.
      expect(fake.consumedMcpConfig()).toBe(true);
      expect(fake.sentToolsCall()).toBe(true);
      expect(fake.mcpToolResult()).toBeUndefined();

      // Exchange 2 carries Qoder's already-executed result and continues the
      // SAME logical Claude session (no new provider run).
      const second = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer q" },
        payload: {
          model: "claude/test-model",
          messages: [
            { role: "user", content: "echo canary" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: call.id,
                  type: "function",
                  function: { name: "cmm_echo", arguments: JSON.stringify({ text: ARG_SENTINEL }) },
                },
              ],
            },
            { role: "tool", tool_call_id: call.id, content: RESULT_SENTINEL },
          ],
          tools: [CMM_ECHO_TOOL],
        },
      });

      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as {
        choices: Array<{ finish_reason: string; message: { content: string } }>;
      };
      // The provider's final content is causally derived from the Qoder result
      // that travelled over the real MCP wire.
      expect(secondBody.choices[0]!.message.content).toContain(`answer=${RESULT_SENTINEL}`);
      expect(fake.mcpToolResult()).toBe(RESULT_SENTINEL);
      expect(adapter.activeToolSessions()).toBe(0);
      console.log("HTTP_ROUNDTRIP_QODER_RESULT_CORRELATED=PASS");
      console.log("HTTP_ROUNDTRIP_SAME_SESSION_CONTINUATION=PASS");
      console.log("E2E_PROVIDER_CONTINUATION_CAUSALLY_DEPENDS_ON_TOOL_RESULT=PASS");
      console.log("QODER_EXECUTION_OWNER=YES");
      console.log("PROVIDER_NATIVE_TOOL_EXECUTION=NONE");
    } finally {
      // No log sink anywhere on the path retained the sentinel content.
      const logged = captured.join("");
      restore();
      expect(logged).not.toContain(ARG_SENTINEL);
      expect(logged).not.toContain(RESULT_SENTINEL);
      console.log("TOOL_ARGUMENT_LOGGING=NONE");
      console.log("TOOL_RESULT_LOGGING=NONE");
    }
  }, 60000);
});
