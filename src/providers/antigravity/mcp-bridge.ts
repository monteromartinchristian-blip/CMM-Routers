/**
 * Antigravity deferred MCP bridge (deterministic prototype, no live quota).
 *
 * Reuses the shared park-and-await bridge: the custom local stdio MCP server
 * parks the model-initiated call and awaits Qoder's already-executed result.
 * Registration is deployment-time (`agy mcp add cmm-qoder-tools <bridge>`,
 * local config only); the server never executes filesystem/shell/edit work.
 */
export {
  runMcpBridgeServer,
  serializeMcpError,
  serializeMcpResponse,
  type BridgedToolRequest,
  type DeferredToolUse,
  type McpBridgeOptions,
} from "../claude/mcp-bridge.js";

export const ANTIGRAVITY_BRIDGE_NAME = "cmm-qoder-tools";

export function antigravityMcpAddCommand(bridgePath: string): string {
  return `agy mcp add ${ANTIGRAVITY_BRIDGE_NAME} ${bridgePath}`;
}
