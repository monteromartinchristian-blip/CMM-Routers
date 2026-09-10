import { discoverBridgeSession } from "./session-registry.js";
import { startMcpBridgeProcess } from "./mcp-bridge-process.js";

/**
 * External stdio MCP launcher registered with `agy mcp add` under the
 * dedicated CMM Router-owned name. The registration carries no secrets: this
 * process discovers the single live Router session at startup and delegates to
 * the bridge, which parks each tools/call with the Router and performs no side
 * effect of its own.
 *
 * Fails closed when no session or more than one live session exists.
 */
export function startMcpBridgeLauncher(
  write: (line: string) => void = (line) => process.stdout.write(line),
): boolean {
  const session = discoverBridgeSession();
  if (session === null) {
    write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "no unique live CMM bridge session; refusing to guess a Router session",
        },
      })}\n`,
    );
    return false;
  }
  process.env.CMM_BRIDGE_SOCKET = session.socketPath;
  process.env.CMM_BRIDGE_TOKEN = session.token;
  process.env.CMM_BRIDGE_SERVER_NAME = process.env.CMM_BRIDGE_SERVER_NAME ?? "cmm_qoder";
  process.env.CMM_BRIDGE_TOOLS = JSON.stringify(session.tools);
  startMcpBridgeProcess(write);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpBridgeLauncher();
}
