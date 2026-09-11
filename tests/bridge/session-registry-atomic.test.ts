import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BridgeSessionRegistry,
  REGISTRY_DIR_ENV,
  type BridgeSessionDescriptor,
} from "../../src/bridge/session-registry.js";
import { RouterError } from "../../src/core/errors.js";

/**
 * Descriptor publication must be atomic.
 *
 * The Antigravity MCP launcher polls the exact final path `agy-<pid>.json` and
 * the reconciliation path treats malformed JSON as stale and deletes it. A
 * truncate-then-write publication therefore lets a concurrent reader observe a
 * partial (empty or torn) descriptor and delete it out from under the writer.
 */

let dir: string;
let previousDir: string | undefined;
const children: ChildProcess[] = [];

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function sha1(value: string | Buffer): string {
  return createHash("sha1").update(value).digest("hex");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmm-registry-atomic-"));
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

function socketFor(name: string): string {
  const path = join(dir, `${name}.sock`);
  writeFileSync(path, "");
  return path;
}

function descriptorFile(pid: number): string {
  return join(dir, `agy-${pid}.json`);
}

/**
 * A large MCP tool list (120 entries, ~20KB of JSON) published repeatedly.
 *
 * The observable partial state is the file that still exists but is empty
 * between `open(O_TRUNC)` and the data landing: a fixed, syscall-sized window
 * per publication. What decides whether a reader catches it is the reader's
 * sampling period, so the payload is kept large enough to be representative
 * but small enough that the reader keeps polling densely. Measured against the
 * unfixed writer: PARTIAL=0 for a multi-MB payload (the reader's parse cost
 * widens its sampling period), PARTIAL=14..21 across runs for this size with
 * the iteration count below.
 */
const TOOL_COUNT = 120;
const TOOL_PADDING = 140;
/** Distinct live provider pids: each final descriptor path is republished. */
const POOL_SIZE = 4;
/** Publications per pid: ROUNDS * POOL_SIZE total publications. */
const ROUNDS = 150;

function largeTools(): BridgeSessionDescriptor["tools"] {
  const tools: BridgeSessionDescriptor["tools"] = [];
  for (let index = 0; index < TOOL_COUNT; index += 1) {
    tools.push({
      name: `cmm_tool_${index}`,
      description: `tool-${index}-${"x".repeat(TOOL_PADDING)}`,
      inputSchema: { type: "object", properties: { payload: { type: "string" } } },
    });
  }
  return tools;
}

function descriptor(agyPid: number, sessionId: string, socketPath: string): BridgeSessionDescriptor {
  return {
    sessionId,
    agyPid,
    socketPath,
    token: `token-${sessionId}`,
    tools: largeTools(),
  };
}

/** The temp publication names the production code must never count as descriptors. */
const TEMP_NAME_PATTERN = /^\.tmp-agy-\d+-[0-9a-z]+-\d+$/;

function leftoverTempFiles(): string[] {
  return readdirSync(dir).filter((entry) => TEMP_NAME_PATTERN.test(entry));
}

/** Any temp-looking entry, whatever its exact shape: nothing may be leaked. */
function anyTempEntries(): string[] {
  return readdirSync(dir).filter((entry) => entry.startsWith(".tmp-agy-"));
}

function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    sleepSync(5);
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reader child did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Real out-of-process reader. It polls the exact final descriptor path the
 * production launcher polls: readFileSync + JSON.parse. Anything that exists but
 * is not a complete, structurally valid descriptor counts as PARTIAL — exactly
 * the observation that makes the launcher (and reconcileOnDisk) delete the file.
 */
const READER_SCRIPT = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
const stopPath = args[1];
const outPath = args[2];
const readyPath = args[3];
const paths = args.slice(4).map((pid) => join(dir, "agy-" + pid + ".json"));

let successful = 0;
let partial = 0;
let partialEmpty = 0;
let partialTorn = 0;
let missing = 0;
const observed = new Set();
let finalHashes = [];
const deadline = Date.now() + 120000;

writeFileSync(readyPath, "ready");

for (;;) {
  const stopping = existsSync(stopPath) || Date.now() > deadline;
  // One extra full sweep after the writer stops, so every final descriptor is
  // read byte-for-byte instead of racing the very last publication.
  const recordFinal = stopping && finalHashes.length === 0;
  for (const path of paths) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      missing += 1;
      continue;
    }
    const text = bytes.toString("utf-8");
    let valid = false;
    try {
      const parsed = JSON.parse(text);
      valid =
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.sessionId === "string" &&
        Array.isArray(parsed.tools);
    } catch {
      valid = false;
    }
    if (!valid) {
      partial += 1;
      if (bytes.length === 0) partialEmpty += 1;
      else partialTorn += 1;
      continue;
    }
    successful += 1;
    const digest = createHash("sha1").update(text, "utf-8").digest("hex");
    observed.add(digest);
    if (recordFinal) finalHashes.push(digest);
  }
  if (stopping) break;
}

writeFileSync(
  outPath,
  JSON.stringify({
    successful,
    partial,
    partialEmpty,
    partialTorn,
    missing,
    observed: [...observed],
    finalHashes,
  }),
);
`;

interface ReaderResult {
  successful: number;
  partial: number;
  partialEmpty: number;
  partialTorn: number;
  missing: number;
  observed: string[];
  finalHashes: string[];
}

describe("bridge session descriptor atomic publication", () => {
  it(
    "never exposes a partial descriptor to a concurrent polling reader",
    async () => {
      const pids: number[] = [];
      for (let index = 0; index < POOL_SIZE; index += 1) pids.push(spawnLivePid());
      const socketPath = socketFor("atomic");

      const scriptPath = join(dir, "reader.mjs");
      const stopPath = join(dir, "reader.stop");
      const outPath = join(dir, "reader-results.json");
      const readyPath = join(dir, "reader-ready");
      writeFileSync(scriptPath, READER_SCRIPT);
      const reader = spawn(
        process.execPath,
        [scriptPath, dir, stopPath, outPath, readyPath, ...pids.map(String)],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      children.push(reader);
      waitForFile(readyPath, 30_000);

      const publishedHashes = new Set<string>();
      const finalByPid = new Map<number, string>();
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const pid of pids) {
          const value = descriptor(pid, `session-${round}-${pid}`, socketPath);
          const json = JSON.stringify(value);
          new BridgeSessionRegistry(POOL_SIZE + 4).register(value);
          publishedHashes.add(sha1(json));
          finalByPid.set(pid, json);
        }
      }

      writeFileSync(stopPath, "");
      await waitForExit(reader, 60_000);
      const results = JSON.parse(readFileSync(outPath, "utf-8")) as ReaderResult;

      console.log(
        `SESSION_DESCRIPTOR_RACE_READS=${results.successful} PARTIAL=${results.partial} ` +
          `(EMPTY=${results.partialEmpty} TORN=${results.partialTorn}) MISSING=${results.missing}`,
      );

      // The reader really ran and really parsed descriptors.
      expect(results.successful).toBeGreaterThan(0);
      // The heart of the defect: no reader ever saw an empty or torn descriptor.
      expect(results.partial).toBe(0);
      // Every byte the reader parsed came from a descriptor the writer published.
      const unexpected = results.observed.filter((digest) => !publishedHashes.has(digest));
      expect(unexpected).toEqual([]);

      // Byte equality: every published descriptor is on disk byte-for-byte, and
      // the reader read exactly that many byte-identical descriptors.
      const expectedFinal = [...finalByPid.entries()].map(([pid, json]) => ({
        pid,
        json,
        digest: sha1(json),
      }));
      let exactMatches = 0;
      for (const { pid, json } of expectedFinal) {
        const bytes = readFileSync(descriptorFile(pid));
        const expected = Buffer.from(json, "utf-8");
        expect(bytes.length).toBe(expected.length);
        expect(bytes.equals(expected)).toBe(true);
        exactMatches += 1;
      }
      expect(exactMatches).toBe(expectedFinal.length);
      expect(results.finalHashes.length).toBe(expectedFinal.length);
      expect(new Set(results.finalHashes)).toEqual(new Set(expectedFinal.map((entry) => entry.digest)));

      // Temp publication files are never mistaken for descriptors and none leak.
      expect(anyTempEntries()).toEqual([]);
      expect(leftoverTempFiles()).toEqual([]);
      expect(BridgeSessionRegistry.descriptorsOnDisk()).toBe(POOL_SIZE);

      console.log("SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS");
      console.log("SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO");
    },
    180_000,
  );

  it("publishes the final descriptor with mode 0600", () => {
    const owner = spawnLivePid();
    const registry = new BridgeSessionRegistry();
    const value = descriptor(owner, "mode-session", socketFor("mode"));
    const release = registry.register(value);

    const path = descriptorFile(owner);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(path);
    expect(bytes.toString("utf-8")).toBe(JSON.stringify(value));
    expect(anyTempEntries()).toEqual([]);
    expect(leftoverTempFiles()).toEqual([]);
    expect(BridgeSessionRegistry.descriptorsOnDisk()).toBe(1);

    release();
    expect(existsSync(path)).toBe(false);
    console.log("SESSION_DESCRIPTOR_MODE_0600=PASS");
  });

  it("cleans abandoned temp files from crashed writers and keeps the final descriptors", () => {
    // A verified-live descriptor written by another Router run (live pid, real
    // socket) plus two temp files left behind by crashed writers.
    const foreign = spawnLivePid();
    const foreignPath = descriptorFile(foreign);
    const foreignJson = JSON.stringify(descriptor(foreign, "foreign-session", socketFor("foreign")));
    writeFileSync(foreignPath, foreignJson, { mode: 0o600 });
    const abandoned = [
      join(dir, ".tmp-agy-999991-abcdefgh-1"),
      join(dir, ".tmp-agy-999992-xyz123-42"),
    ];
    for (const path of abandoned) writeFileSync(path, "{ partial", { mode: 0o600 });
    writeFileSync(join(dir, "notes.txt"), "unrelated");

    const registry = new BridgeSessionRegistry();
    const own = spawnLivePid();
    const release = registry.register(descriptor(own, "own-session", socketFor("own")));

    for (const path of abandoned) expect(existsSync(path)).toBe(false);
    expect(anyTempEntries()).toEqual([]);
    // The cleanup must not touch final descriptors, unrelated files, or the
    // descriptor of another verified-live run.
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(foreignPath)).toBe(true);
    expect(readFileSync(foreignPath, "utf-8")).toBe(foreignJson);
    expect(readFileSync(descriptorFile(own), "utf-8")).toBe(
      JSON.stringify({
        sessionId: "own-session",
        agyPid: own,
        socketPath: join(dir, "own.sock"),
        token: "token-own-session",
        tools: largeTools(),
      }),
    );
    expect(BridgeSessionRegistry.descriptorsOnDisk()).toBe(2);
    release();
  });

  it("never overwrites a verified-live descriptor owned by another run", () => {
    const first = spawnLivePid();
    const second = spawnLivePid();
    const registry = new BridgeSessionRegistry();

    const releaseFirst = registry.register(descriptor(first, "first-session", socketFor("first")));
    const firstPath = descriptorFile(first);
    const firstBytes = readFileSync(firstPath);

    const releaseSecond = registry.register(descriptor(second, "second-session", socketFor("second")));
    expect(existsSync(firstPath)).toBe(true);
    expect(readFileSync(firstPath).equals(firstBytes)).toBe(true);

    // The duplicate-pid guard still refuses a second run for a live selector.
    let thrown: unknown;
    try {
      registry.register(descriptor(first, "first-again", socketFor("first")));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).code).toBe("provider_protocol_error");
    expect(readFileSync(firstPath).equals(firstBytes)).toBe(true);

    releaseSecond();
    expect(existsSync(firstPath)).toBe(true);
    releaseFirst();
    expect(existsSync(firstPath)).toBe(false);
    expect(leftoverTempFiles()).toEqual([]);
  });
});
