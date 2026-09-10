import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-session rendezvous for the Antigravity MCP bridge.
 *
 * `agy mcp add` registers a persistent server command, so the registration
 * itself must never carry a per-session socket path or token. Instead the
 * Router publishes a per-session descriptor here (mode 0600) and the launcher
 * the registration points at discovers the single live session at startup.
 */

const REGISTRY_DIR = join(tmpdir(), "cmm-bridge-registry");

export interface BridgeSessionDescriptor {
  socketPath: string;
  token: string;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

function sessionFile(sessionId: string): string {
  return join(REGISTRY_DIR, `${sessionId}.json`);
}

export function registerBridgeSession(
  sessionId: string,
  descriptor: BridgeSessionDescriptor,
): () => void {
  mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  const path = sessionFile(sessionId);
  writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
  return () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort: the launcher already fails closed on stale entries.
    }
  };
}

/**
 * Find the single live session. Ambiguity (or none) fails closed: the launcher
 * must never guess which Router session an MCP call belongs to.
 */
export function discoverBridgeSession(): BridgeSessionDescriptor | null {
  if (!existsSync(REGISTRY_DIR)) return null;
  const live: BridgeSessionDescriptor[] = [];
  for (const entry of readdirSync(REGISTRY_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(join(REGISTRY_DIR, entry), "utf-8"),
      ) as BridgeSessionDescriptor;
      if (typeof parsed.socketPath !== "string" || typeof parsed.token !== "string") continue;
      // A descriptor whose control socket is gone is stale.
      if (!existsSync(parsed.socketPath)) continue;
      live.push(parsed);
    } catch {
      continue;
    }
  }
  if (live.length !== 1) return null;
  return live[0]!;
}
