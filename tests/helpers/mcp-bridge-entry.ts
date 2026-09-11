/**
 * Minimal stdio MCP bridge entry used to exercise the provider-facing frame
 * bound of `runMcpBridgeServer` in an isolated child process. The handler never
 * executes anything; it only parks and waits.
 */
import { runMcpBridgeServer } from "../../src/providers/claude/mcp-bridge.js";

runMcpBridgeServer({ serverName: "frame-bound-canary", tools: [] }, async () => "unused");
// Stay alive until the transport fails closed or stdin closes.
setInterval(() => undefined, 1000);
