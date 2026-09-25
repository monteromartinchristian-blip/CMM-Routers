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
const TSX = join(REPO, "node_modules/.bin/tsx");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");

const CMMCHAT_TOKEN = "broker-generic-cmmchat-secret";
const CODE_TOKEN = "broker-generic-code-secret";

class DiscoveryStubClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/generic-broker-model",
        provider: "claude",
        upstreamModel: "generic-broker-model",
        displayName: "Generic Broker Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
}

/**
 * Proves the shared deferred-tool broker and the production MCP bridge work
 * for a client that is NOT Qoder.
 *
 * The server is composed with ONLY the canonical Code Router bearer: no legacy
 * Qoder credential exists in this process at all. The client identifies as a
 * generic OpenAI-compatible harness. The Router parks the provider call, the
 * client executes the tool, submits the result, and the SAME provider session
 * continues to a terminal answer causally derived from that result.
 */
describe("generic Code Router client — production broker/bridge round trip", () => {
  it(
    "completes the full broker round trip without any Qoder identity",
    { timeout: 60000 },
    async () => {
      const ARG_SENTINEL = "CMM_GENERIC_BROKER_ARG_4b7e21";
      const RESULT_SENTINEL = "CMM_GENERIC_BROKER_RESULT_8d1c93";

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

      // Canonical Code Router bearer ONLY — no legacy Qoder credential.
      const server = buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: CMMCHAT_TOKEN,
        codeRouterToken: CODE_TOKEN,
        registry,
      });
      const auth = {
        authorization: `Bearer ${CODE_TOKEN}`,
        "x-cmm-client": "generic-openai",
      };

      try {
        // Exchange 1 parks the provider call in the shared broker.
        const first = await server.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "claude/generic-broker-model",
            messages: [{ role: "user", content: "echo canary" }],
            tools: [CMM_ECHO_TOOL],
          },
        });
        expect(first.statusCode).toBe(200);
        const firstBody = first.json() as {
          model: string;
          choices: Array<{
            finish_reason: string;
            message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
          }>;
        };
        expect(firstBody.model).toBe("claude/generic-broker-model");
        expect(firstBody.choices[0]!.finish_reason).toBe("tool_calls");
        const call = firstBody.choices[0]!.message.tool_calls![0]!;
        expect(call.id.startsWith("cmm_claude_")).toBe(true);
        expect(call.function.name).toBe("cmm_echo");
        expect(fake.consumedMcpConfig()).toBe(true);
        expect(fake.sentToolsCall()).toBe(true);
        // Nothing executed locally: the MCP call is still unanswered.
        expect(fake.mcpToolResult()).toBeUndefined();
        console.log("GENERIC_BROKER_TOOL_CALL_SURFACED=PASS");

        // Exchange 2 carries the client-executed result and continues the SAME
        // provider session.
        const second = await server.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth,
          payload: {
            model: "claude/generic-broker-model",
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
          model: string;
          choices: Array<{ finish_reason: string; message: { content: string } }>;
        };
        expect(secondBody.model).toBe("claude/generic-broker-model");
        expect(secondBody.choices[0]!.finish_reason).toBe("stop");
        // Causally derived from the client-supplied result that travelled over
        // the real MCP wire.
        expect(secondBody.choices[0]!.message.content).toContain(`answer=${RESULT_SENTINEL}`);
        expect(fake.mcpToolResult()).toBe(RESULT_SENTINEL);
        expect(adapter.activeToolSessions()).toBe(0);
        console.log("GENERIC_OPENAI_CODE_ROUTER=PASS");
        console.log("CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES");
        console.log("CLIENT_OWNS_TOOLS=YES");
        console.log("PROVIDER_NATIVE_TOOL_EXECUTION=NONE");
      } finally {
        const logged = captured.join("");
        restore();
        expect(logged).not.toContain(ARG_SENTINEL);
        expect(logged).not.toContain(RESULT_SENTINEL);
        console.log("TOOL_ARGUMENT_LOGGING=NONE");
        console.log("TOOL_RESULT_LOGGING=NONE");
      }
    },
  );
});
