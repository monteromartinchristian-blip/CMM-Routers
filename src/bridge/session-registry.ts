import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterError } from "../core/errors.js";

/**
 * Per-run rendezvous for the Antigravity MCP bridge.
 *
 * `agy mcp add` registers a persistent, secret-free server command, so the
 * registration itself can never carry a per-run socket path or token. Instead
 * the Router publishes one descriptor per live provider run and the launcher
 * locates the descriptor that belongs to ITS OWN agy process.
 *
 * Selector: the agy process id. An MCP stdio server is by definition a
 * descendant of the agy process that spawned it, and a pid identifies exactly
 * one live process. This correlates one launcher with one Router session
 * without scanning a global pool and without assuming anything about how agy
 * propagates its environment to MCP children.
 */

export const REGISTRY_DIR_ENV = "CMM_BRIDGE_REGISTRY_DIR";
export const SESSION_SELECTOR_ENV = "CMM_BRIDGE_SESSION_ID";
export const SESSION_REGISTRY_MAX_LIVE = 64;
export const MAX_ANCESTOR_DEPTH = 4;

export interface BridgeToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeSessionDescriptor {
  /** Router-generated per-run session id (also the request id). */
  sessionId: string;
  /** Exact provider process this descriptor belongs to. */
  agyPid: number;
  socketPath: string;
  token: string;
  tools: BridgeToolSpec[];
}

export function registryDir(): string {
  const override = process.env[REGISTRY_DIR_ENV];
  return typeof override === "string" && override.length > 0
    ? override
    : join(tmpdir(), "cmm-bridge-registry");
}

function selectorFile(agyPid: number): string {
  return join(registryDir(), `agy-${agyPid}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the pid names a live process owned by this user (or another user). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ancestor pid chain for a launcher process, closest first. Bounded depth so a
 * pathological process tree cannot turn selection into an open-ended walk.
 */
export function ancestorPids(
  startPid: number = process.ppid,
  depth: number = MAX_ANCESTOR_DEPTH,
): number[] {
  const chain: number[] = [];
  let current = startPid;
  for (let step = 0; step < depth; step += 1) {
    if (!Number.isInteger(current) || current <= 1) break;
    chain.push(current);
    let parent: number;
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(current)], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      parent = Number.parseInt(out.trim(), 10);
    } catch {
      break;
    }
    if (!Number.isFinite(parent) || parent <= 1 || parent === current) break;
    current = parent;
  }
  return chain;
}

/**
 * Read and validate the descriptor for one exact provider process. Returns
 * null when the descriptor is absent, malformed, or stale (dead owner or gone
 * control socket). Stale files are removed so they cannot be resolved later.
 */
export function readSessionDescriptor(
  agyPid: number,
  pidAlive: (pid: number) => boolean = isProcessAlive,
): BridgeSessionDescriptor | null {
  const path = selectorFile(agyPid);
  if (!existsSync(path)) return null;
  let parsed: BridgeSessionDescriptor;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      !isRecord(value) ||
      typeof value.sessionId !== "string" ||
      typeof value.agyPid !== "number" ||
      typeof value.socketPath !== "string" ||
      typeof value.token !== "string" ||
      !Array.isArray(value.tools)
    ) {
      rmSync(path, { force: true });
      return null;
    }
    parsed = value as unknown as BridgeSessionDescriptor;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
  if (parsed.agyPid !== agyPid || !pidAlive(agyPid) || !existsSync(parsed.socketPath)) {
    rmSync(path, { force: true });
    return null;
  }
  return parsed;
}

export interface ResolveResult {
  descriptor: BridgeSessionDescriptor | null;
  reason: string;
}

/**
 * Resolve the descriptor that belongs to this exact launcher.
 *
 * Primary correlation is process identity: only the descriptor whose owner pid
 * is one of this launcher's own ancestors can match. When the Router also
 * exported an explicit per-run selector into the agy environment it is used as
 * a verification signal, so a selector belonging to a different live session is
 * rejected instead of silently honoured.
 */
export function resolveBridgeSession(options: {
  envSelector?: string | undefined;
  ancestors?: number[];
  pidAlive?: (pid: number) => boolean;
} = {}): ResolveResult {
  const ancestors = options.ancestors ?? ancestorPids();
  const alive = options.pidAlive ?? isProcessAlive;
  const envSelector = options.envSelector;
  let sawDescriptor = false;
  let sawForeignSelector = false;
  for (const pid of ancestors) {
    const descriptor = readSessionDescriptor(pid, alive);
    if (descriptor === null) continue;
    sawDescriptor = true;
    if (envSelector !== undefined && envSelector.length > 0 && descriptor.sessionId !== envSelector) {
      // A selector that names another live session must never be honoured.
      sawForeignSelector = true;
      continue;
    }
    return { descriptor, reason: "ancestor-pid" };
  }
  if (sawForeignSelector) {
    return { descriptor: null, reason: "selector-belongs-to-another-session" };
  }
  if (sawDescriptor) return { descriptor: null, reason: "stale-selector" };
  return { descriptor: null, reason: "no-selector-for-this-run" };
}

/**
 * Router-side registry of live parked provider runs. The number of live
 * descriptors is explicitly bounded: a finite TTL alone is not a maximum under
 * burst load.
 */
export class BridgeSessionRegistry {
  /** agyPid -> sessionId */
  private readonly live = new Map<number, string>();

  constructor(private readonly maxLive: number = SESSION_REGISTRY_MAX_LIVE) {}

  liveCount(): number {
    return this.live.size;
  }

  maxLiveSessions(): number {
    return this.maxLive;
  }

  register(descriptor: BridgeSessionDescriptor): () => void {
    if (this.live.size >= this.maxLive) {
      throw new RouterError(
        "provider_rate_limited",
        "Bridge session registry is at capacity; refusing another provider tool session",
      );
    }
    if (this.live.has(descriptor.agyPid)) {
      throw new RouterError(
        "provider_protocol_error",
        "Duplicate bridge session selector for a live provider run",
      );
    }
    for (const sessionId of this.live.values()) {
      if (sessionId === descriptor.sessionId) {
        throw new RouterError(
          "provider_protocol_error",
          "Duplicate bridge session id for a live provider run",
        );
      }
    }
    const dir = registryDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(selectorFile(descriptor.agyPid), JSON.stringify(descriptor), {
      mode: 0o600,
    });
    this.live.set(descriptor.agyPid, descriptor.sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        rmSync(selectorFile(descriptor.agyPid), { force: true });
      } catch {
        // Best effort: a stale descriptor is rejected by the launcher anyway.
      }
      this.live.delete(descriptor.agyPid);
    };
  }

  /** Test/diagnostic: number of descriptors currently on disk. */
  static descriptorsOnDisk(): number {
    const dir = registryDir();
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((entry) => entry.startsWith("agy-")).length;
    } catch {
      return 0;
    }
  }
}
