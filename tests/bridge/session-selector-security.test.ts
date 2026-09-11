import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeSessionRegistry,
  REGISTRY_DIR_ENV,
  SESSION_REGISTRY_MAX_LIVE,
  resolveBridgeSession,
  type BridgeSessionDescriptor,
} from "../../src/bridge/session-registry.js";
import { RouterError } from "../../src/core/errors.js";

let dir: string;
let socketPath: string;
let previousDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmm-selector-"));
  socketPath = join(dir, "bridge.sock");
  // A real file stands in for the live control socket.
  writeFileSync(socketPath, "");
  previousDir = process.env[REGISTRY_DIR_ENV];
  process.env[REGISTRY_DIR_ENV] = dir;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env[REGISTRY_DIR_ENV];
  else process.env[REGISTRY_DIR_ENV] = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

function descriptor(agyPid: number, sessionId: string): BridgeSessionDescriptor {
  return {
    sessionId,
    agyPid,
    socketPath,
    token: `token-${sessionId}`,
    tools: [{ name: "cmm_echo", inputSchema: { type: "object" } }],
  };
}

const alive = (): boolean => true;
const dead = (): boolean => false;

describe("bridge session selector isolation", () => {
  it("resolves the descriptor that belongs to this exact provider run", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(1111, "session-A"));
    registry.register(descriptor(2222, "session-B"));

    // Each launcher resolves only its own run's descriptor.
    const a = resolveBridgeSession({ ancestors: [1111], pidAlive: alive });
    const b = resolveBridgeSession({ ancestors: [2222], pidAlive: alive });
    expect(a.descriptor?.sessionId).toBe("session-A");
    expect(b.descriptor?.sessionId).toBe("session-B");
    console.log("BRIDGE_SESSION_SELECTOR_ISOLATION=PASS");
  });

  it("rejects a selector that belongs to another live session", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(1111, "session-A"));
    registry.register(descriptor(2222, "session-B"));

    // A launcher for run A must not accept run B's selector.
    const result = resolveBridgeSession({
      ancestors: [1111],
      envSelector: "session-B",
      pidAlive: alive,
    });
    expect(result.descriptor).toBeNull();
    expect(result.reason).toBe("selector-belongs-to-another-session");
    console.log("BRIDGE_CROSS_SESSION_SELECTOR_REJECTED=PASS");
  });

  it("rejects a stale descriptor and removes it", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(3333, "session-stale"));

    // The owning provider process is gone: the descriptor must not resolve.
    const result = resolveBridgeSession({ ancestors: [3333], pidAlive: dead });
    expect(result.descriptor).toBeNull();
    expect(result.reason).toBe("no-selector-for-this-run");
    expect(existsSync(join(dir, "agy-3333.json"))).toBe(false);
    console.log("BRIDGE_STALE_SESSION_REJECTED=PASS");
  });

  it("rejects a missing selector for this run", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(1111, "session-A"));
    const result = resolveBridgeSession({ ancestors: [9999], pidAlive: alive });
    expect(result.descriptor).toBeNull();
    expect(result.reason).toBe("no-selector-for-this-run");
  });

  it("refuses a duplicate selector for the same live provider run", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(4444, "session-A"));
    expect(() => registry.register(descriptor(4444, "session-B"))).toThrow(RouterError);
  });

  it("refuses a duplicate session id for a live provider run", () => {
    const registry = new BridgeSessionRegistry();
    registry.register(descriptor(5555, "session-A"));
    expect(() => registry.register(descriptor(6666, "session-A"))).toThrow(RouterError);
  });

  it("releases the descriptor on terminal cleanup", () => {
    const registry = new BridgeSessionRegistry();
    const release = registry.register(descriptor(7777, "session-A"));
    expect(registry.liveCount()).toBe(1);
    release();
    expect(registry.liveCount()).toBe(0);
    expect(existsSync(join(dir, "agy-7777.json"))).toBe(false);
    // A released selector can be re-registered (not reusable indefinitely).
    registry.register(descriptor(7777, "session-A"));
    expect(registry.liveCount()).toBe(1);
  });

  it("rejects a malformed descriptor file and removes it", () => {
    writeFileSync(join(dir, "agy-8888.json"), "{ not json");
    const result = resolveBridgeSession({ ancestors: [8888], pidAlive: alive });
    expect(result.descriptor).toBeNull();
    expect(existsSync(join(dir, "agy-8888.json"))).toBe(false);
  });
});

describe("bridge session registry bound", () => {
  it("fails closed at the declared maximum live sessions", () => {
    const registry = new BridgeSessionRegistry(2);
    expect(registry.maxLiveSessions()).toBe(2);
    expect(SESSION_REGISTRY_MAX_LIVE).toBe(64);
    registry.register(descriptor(11, "s1"));
    registry.register(descriptor(22, "s2"));
    expect(registry.liveCount()).toBe(2);
    let thrown: unknown;
    try {
      registry.register(descriptor(33, "s3"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).code).toBe("provider_rate_limited");
    expect(registry.liveCount()).toBe(2);
    console.log("SESSION_REGISTRY_MAX_LIVE=64");
    console.log("SESSION_REGISTRY_OVERFLOW_FAIL_CLOSED=PASS");
  });

  it("releases capacity when a session terminates", () => {
    const registry = new BridgeSessionRegistry(1);
    const release = registry.register(descriptor(11, "s1"));
    expect(() => registry.register(descriptor(22, "s2"))).toThrow(RouterError);
    release();
    registry.register(descriptor(22, "s2"));
    expect(registry.liveCount()).toBe(1);
  });
});
