import { resolveBridgeSession, SESSION_SELECTOR_ENV, type BridgeSessionDescriptor } from "./session-registry.js";
import { startMcpBridgeProcess } from "./mcp-bridge-process.js";

/**
 * External stdio MCP launcher registered with `agy mcp add` under the
 * dedicated CMM Router-owned name. The registration carries no secrets.
 *
 * The launcher resolves the ONE Router session that belongs to its own agy
 * process (see session-registry) and delegates to the bridge, which parks each
 * tools/call with the Router and performs no side effect of its own.
 *
 * Fails closed when the owning session cannot be determined exactly. It never
 * scans a global pool and never guesses "the only live session".
 */

/**
 * Bounded wait for the owning descriptor. The Router publishes the descriptor
 * once it knows the agy pid, which can be marginally after the MCP child is
 * spawned. A short bounded wait keeps the handshake deterministic without ever
 * falling back to an ambiguous selection.
 */
export const DESCRIPTOR_WAIT_MS = 5000;
const DESCRIPTOR_POLL_MS = 25;

function sleepSync(ms: number): void {
  // Blocking sleep is correct here: the MCP stdio handshake must not proceed
  // until the owner is known, and Node cannot await inside this entry point.
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

export function awaitBridgeSession(
  options: {
    envSelector?: string | undefined;
    waitMs?: number;
    resolve?: typeof resolveBridgeSession;
  } = {},
): { descriptor: BridgeSessionDescriptor | null; reason: string } {
  const selector =
    options.envSelector ?? (process.env[SESSION_SELECTOR_ENV] ?? undefined);
  const resolve = options.resolve ?? resolveBridgeSession;
  const deadline = Date.now() + (options.waitMs ?? DESCRIPTOR_WAIT_MS);
  let last: { descriptor: BridgeSessionDescriptor | null; reason: string } = {
    descriptor: null,
    reason: "no-selector-for-this-run",
  };
  for (;;) {
    last = resolve({ envSelector: selector });
    if (last.descriptor !== null) return last;
    if (Date.now() >= deadline) return last;
    sleepSync(DESCRIPTOR_POLL_MS);
  }
}

export function startMcpBridgeLauncher(
  write: (line: string) => void = (line) => process.stdout.write(line),
  resolve?: typeof resolveBridgeSession,
): boolean {
  const resolved = awaitBridgeSession(resolve !== undefined ? { resolve } : {});
  if (resolved.descriptor === null) {
    write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: `no exact CMM bridge session for this provider run (${resolved.reason})`,
        },
      })}\n`,
    );
    return false;
  }
  const session = resolved.descriptor;
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
