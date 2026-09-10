import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** Descriptor file naming contract: `agy-<pid>.json`, nothing else. */
const DESCRIPTOR_FILE = /^agy-(\d+)\.json$/;
/**
 * Temp publication names. Deliberately outside the descriptor contract and
 * without the `agy-` prefix, so a partially written temp file can neither be
 * mistaken for a descriptor nor counted as one by `descriptorsOnDisk()`.
 */
const TEMP_DESCRIPTOR_FILE = /^\.tmp-agy-\d+-[0-9a-z]+-\d+$/;
const TEMP_DESCRIPTOR_PREFIX = ".tmp-agy-";
/** Exclusive lock file guarding the registry directory critical section. */
const LOCK_FILE_NAME = ".lock";
/** Bound on how long a registration waits for the directory lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
/** A lock older than this was left by a crashed process and is reclaimed. */
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

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

function descriptorPath(dir: string, agyPid: number): string {
  return join(dir, `agy-${agyPid}.json`);
}

function selectorFile(agyPid: number): string {
  return descriptorPath(registryDir(), agyPid);
}

let tempSerial = 0;

/**
 * Unique temp path in the SAME directory as the final descriptor, so the
 * publishing rename can never cross a filesystem boundary. Uniqueness covers
 * concurrent writers in this process (serial counter) and other processes
 * (pid + random suffix).
 */
function nextTempDescriptorPath(dir: string): string {
  tempSerial += 1;
  const random = Math.random().toString(36).slice(2, 10) || "0";
  return join(dir, `${TEMP_DESCRIPTOR_PREFIX}${process.pid}-${random}-${tempSerial}`);
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
  // Same structural validation the registry reconciliation uses.
  const parsed = readDescriptorStructure(path);
  if (parsed === null) {
    removeFileQuietly(path);
    return null;
  }
  if (parsed.agyPid !== agyPid || !pidAlive(agyPid) || !existsSync(parsed.socketPath)) {
    removeFileQuietly(path);
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
 *
 * The bound is enforced against the EFFECTIVE registry — the reconciled set of
 * descriptors on disk unioned with this process's in-memory live set — so a
 * Router restart cannot inherit a stale, empty in-memory view of the bound, and
 * two Router processes sharing one registry directory cannot each believe they
 * are below the global maximum. The reconcile → count → publish critical section
 * runs under an exclusive directory lock.
 */
export class BridgeSessionRegistry {
  /** agyPid -> sessionId */
  private readonly live = new Map<number, string>();
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(
    private readonly maxLive: number = SESSION_REGISTRY_MAX_LIVE,
    options: { lockTimeoutMs?: number; staleLockMs?: number } = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  liveCount(): number {
    return this.live.size;
  }

  maxLiveSessions(): number {
    return this.maxLive;
  }

  register(descriptor: BridgeSessionDescriptor): () => void {
    const dir = registryDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return this.withDirectoryLock(dir, () => {
      const onDisk = this.reconcileOnDisk(dir);
      const effective = new Set<number>(onDisk);
      for (const pid of this.live.keys()) effective.add(pid);
      if (effective.size >= this.maxLive) {
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
      this.removeAbandonedTempFiles(dir);
      this.publishDescriptor(dir, descriptor);
      this.live.set(descriptor.agyPid, descriptor.sessionId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(descriptorPath(dir, descriptor.agyPid), { force: true });
        } catch {
          // Best effort: a stale descriptor is rejected by the launcher anyway.
        }
        this.live.delete(descriptor.agyPid);
      };
    });
  }

  /**
   * Publish the descriptor atomically. The launcher polls the FINAL path
   * directly (`agy-<pid>.json`), and reconciliation treats malformed JSON as
   * stale and deletes it, so a truncated or empty file must never be visible
   * there: the complete payload is written to a unique temp file in the same
   * directory, flushed to stable storage, and only then renamed onto the final
   * path. `rename` is atomic, so a concurrent reader observes either the
   * previous descriptor or the new one, never a partial one.
   */
  private publishDescriptor(dir: string, descriptor: BridgeSessionDescriptor): void {
    const payload = JSON.stringify(descriptor);
    const tempPath = nextTempDescriptorPath(dir);
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, "wx", 0o600);
      writeFileSync(fd, payload);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, descriptorPath(dir, descriptor.agyPid));
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already closed; the original error is the one that matters.
        }
      }
      removeFileQuietly(tempPath);
      throw error;
    }
  }

  /**
   * Remove temp files abandoned by crashed writers. Only ever called while
   * holding the directory lock, which serializes every writer, so a matching
   * file is guaranteed to be orphaned. Final descriptors are never touched.
   */
  private removeAbandonedTempFiles(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (TEMP_DESCRIPTOR_FILE.test(entry)) removeFileQuietly(join(dir, entry));
    }
  }

  /**
   * Remove every descriptor that cannot belong to a live provider run and
   * return the set of owner pids that survive. A descriptor survives only when
   * its structure validates, its file name matches its owner pid, the owner
   * process is alive, and its control socket still exists. A run this process
   * is actively holding is always treated as verified-live: its descriptor is
   * never removed while the run is parked.
   */
  private reconcileOnDisk(dir: string): Set<number> {
    const surviving = new Set<number>(this.live.keys());
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return surviving;
    }
    for (const entry of entries) {
      const match = DESCRIPTOR_FILE.exec(entry);
      if (match === null) continue;
      const pid = Number.parseInt(match[1] as string, 10);
      if (this.live.has(pid)) continue;
      const path = join(dir, entry);
      const descriptor = readDescriptorStructure(path);
      if (
        descriptor === null ||
        descriptor.agyPid !== pid ||
        !isProcessAlive(pid) ||
        !existsSync(descriptor.socketPath)
      ) {
        removeFileQuietly(path);
        continue;
      }
      surviving.add(pid);
    }
    return surviving;
  }

  /**
   * Run `action` while holding an exclusive directory lock. Fail-closed on
   * contention: past the bounded timeout the caller is refused rather than
   * allowed to race past the global capacity check.
   */
  private withDirectoryLock<T>(dir: string, action: () => T): T {
    const lockPath = join(dir, LOCK_FILE_NAME);
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.reclaimStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new RouterError(
            "provider_rate_limited",
            "Bridge session registry lock is held by another Router process",
          );
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return action();
    } finally {
      removeFileQuietly(lockPath);
    }
  }

  /** True when a lock older than the bounded threshold was reclaimed. */
  private reclaimStaleLock(lockPath: string): boolean {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age <= this.staleLockMs) return false;
      removeFileQuietly(lockPath);
      return true;
    } catch {
      // The lock disappeared underneath us: retry acquisition immediately.
      return true;
    }
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

/** Structural validation only; liveness is decided by the caller. */
function readDescriptorStructure(path: string): BridgeSessionDescriptor | null {
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
      return null;
    }
    return value as unknown as BridgeSessionDescriptor;
  } catch {
    return null;
  }
}

function removeFileQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort; ENOENT and permission errors are not fatal here.
  }
}
