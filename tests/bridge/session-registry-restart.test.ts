import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BridgeSessionRegistry,
  REGISTRY_DIR_ENV,
  SESSION_REGISTRY_MAX_LIVE,
  type BridgeSessionDescriptor,
} from "../../src/bridge/session-registry.js";
import { RouterError } from "../../src/core/errors.js";

let dir: string;
let previousDir: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmm-registry-restart-"));
  previousDir = process.env[REGISTRY_DIR_ENV];
  process.env[REGISTRY_DIR_ENV] = dir;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (previousDir === undefined) delete process.env[REGISTRY_DIR_ENV];
  else process.env[REGISTRY_DIR_ENV] = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

/** A real live process that outlives the test until cleanup kills it. */
function spawnLivePid(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  children.push(child);
  if (child.pid === undefined) throw new Error("spawned child has no pid");
  return child.pid;
}

/** A pid that is guaranteed dead: the child was spawned and reaped. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  if (result.pid === undefined) throw new Error("no pid from spawnSync");
  return result.pid;
}

function socketFor(name: string): string {
  const path = join(dir, `${name}.sock`);
  writeFileSync(path, "");
  return path;
}

function descriptor(pid: number, sessionId: string, socketPath: string): BridgeSessionDescriptor {
  return {
    sessionId,
    agyPid: pid,
    socketPath,
    token: `token-${sessionId}`,
    tools: [{ name: "cmm_echo", inputSchema: { type: "object" } }],
  };
}

function descriptorFile(pid: number): string {
  return join(dir, `agy-${pid}.json`);
}

/** Pre-write a raw descriptor exactly as a previous Router process would have. */
function writeRawDescriptor(pid: number, value: unknown): string {
  const path = descriptorFile(pid);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}

describe("bridge session registry restart reconciliation", () => {
  it("removes a stale descriptor and preserves a verified-live one", () => {
    // Stale: dead owner pid AND a control socket that no longer exists.
    const staleOwner = deadPid();
    const stalePath = writeRawDescriptor(
      staleOwner,
      descriptor(staleOwner, "stale-session", join(dir, "gone.sock")),
    );
    // Stale variant: alive pid but the control socket is gone.
    const missingSocketOwner = spawnLivePid();
    const missingSocketPath = writeRawDescriptor(
      missingSocketOwner,
      descriptor(missingSocketOwner, "missing-socket-session", join(dir, "never-created.sock")),
    );
    // Live: alive owner pid AND an existing control socket.
    const liveOwner = spawnLivePid();
    const livePath = writeRawDescriptor(
      liveOwner,
      descriptor(liveOwner, "live-session", socketFor("live")),
    );

    // maxLive 2 with two stale files on disk: if a stale file counted toward
    // the bound, registering our own (union = 3) would fail closed.
    const registry = new BridgeSessionRegistry(2);
    const ownPid = 4242;
    const release = registry.register(descriptor(ownPid, "own-session", socketFor("own")));

    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(missingSocketPath)).toBe(false);
    expect(existsSync(livePath)).toBe(true);
    expect(registry.liveCount()).toBe(1);
    release();
    expect(existsSync(descriptorFile(ownPid))).toBe(false);
    console.log("SESSION_REGISTRY_STALE_DESCRIPTOR_RECONCILIATION=PASS");
  });

  it("bounds a restarted process by effective on-disk descriptors", () => {
    const owners: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const owner = spawnLivePid();
      owners.push(owner);
      writeRawDescriptor(owner, descriptor(owner, `live-${index}`, socketFor(`live-${index}`)));
    }

    // Restart-equivalent: a fresh registry instance whose in-memory Map is empty.
    const registry = new BridgeSessionRegistry(3);
    expect(registry.liveCount()).toBe(0);
    expect(() => registry.register(descriptor(999001, "extra", socketFor("extra")))).toThrow(
      RouterError,
    );
    try {
      registry.register(descriptor(999001, "extra", socketFor("extra")));
    } catch (error) {
      expect((error as RouterError).code).toBe("provider_rate_limited");
    }
    // The verified-live descriptors are never deleted.
    for (const owner of owners) expect(existsSync(descriptorFile(owner))).toBe(true);
    expect(existsSync(descriptorFile(999001))).toBe(false);
    console.log("SESSION_REGISTRY_EFFECTIVE_DISK_BOUND=PASS");
  });

  it("fails closed when independent registry instances share one directory", () => {
    const maxLive = 2;
    const a = new BridgeSessionRegistry(maxLive);
    const b = new BridgeSessionRegistry(maxLive);
    const pidA = spawnLivePid();
    const pidB = spawnLivePid();

    const releaseA = a.register(descriptor(pidA, "session-a", socketFor("a")));
    const releaseB = b.register(descriptor(pidB, "session-b", socketFor("b")));
    expect(a.liveCount()).toBe(1);
    expect(b.liveCount()).toBe(1);
    expect(BridgeSessionRegistry.descriptorsOnDisk()).toBe(2);

    const c = new BridgeSessionRegistry(maxLive);
    expect(() => c.register(descriptor(999002, "session-c", socketFor("c")))).toThrow(RouterError);
    try {
      c.register(descriptor(999002, "session-c", socketFor("c")));
    } catch (error) {
      expect((error as RouterError).code).toBe("provider_rate_limited");
    }

    // Releasing one run frees global capacity for the next process.
    releaseB();
    const releaseC = c.register(descriptor(999002, "session-c", socketFor("c")));
    expect(c.liveCount()).toBe(1);
    releaseC();
    releaseA();
    console.log("SESSION_REGISTRY_MULTI_PROCESS_RACE_FAIL_CLOSED=PASS");
  });

  it("holds an exclusive lock for the registration critical section only", () => {
    const registry = new BridgeSessionRegistry(4);
    const owner = spawnLivePid();
    const release = registry.register(descriptor(owner, "locked", socketFor("locked")));
    // No lock leak after the critical section.
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    release();

    // A freshly held lock makes registration fail closed rather than race.
    writeFileSync(join(dir, ".lock"), "");
    const contending = new BridgeSessionRegistry(4, {
      lockTimeoutMs: 50,
      staleLockMs: 60_000,
    });
    expect(() => contending.register(descriptor(999003, "blocked", socketFor("blocked")))).toThrow(
      RouterError,
    );
    expect(existsSync(join(dir, ".lock"))).toBe(true);

    // A lock left behind by a crashed process is detected as stale and cleared.
    const old = new Date(Date.now() - 600_000);
    utimesSync(join(dir, ".lock"), old, old);
    const recovered = new BridgeSessionRegistry(4, {
      lockTimeoutMs: 500,
      staleLockMs: 30_000,
    });
    const releaseRecovered = recovered.register(
      descriptor(999004, "recovered", socketFor("recovered")),
    );
    expect(recovered.liveCount()).toBe(1);
    releaseRecovered();
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("removes a malformed descriptor without breaking registration", () => {
    const garbageOwner = deadPid();
    const garbagePath = writeRawDescriptor(garbageOwner, "{ not json");
    const wrongShapeOwner = deadPid();
    const wrongShapePath = writeRawDescriptor(wrongShapeOwner, { sessionId: 7 });

    const registry = new BridgeSessionRegistry(4);
    const owner = spawnLivePid();
    const release = registry.register(descriptor(owner, "healthy", socketFor("healthy")));
    expect(existsSync(garbagePath)).toBe(false);
    expect(existsSync(wrongShapePath)).toBe(false);
    expect(registry.liveCount()).toBe(1);
    release();
  });

  it("keeps the production default bound at 64", () => {
    expect(SESSION_REGISTRY_MAX_LIVE).toBe(64);
    expect(new BridgeSessionRegistry().maxLiveSessions()).toBe(64);
    console.log("SESSION_REGISTRY_MAX_LIVE=64");
  });
});
