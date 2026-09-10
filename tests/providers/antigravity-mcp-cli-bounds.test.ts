import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";
import {
  ensureAntigravityMcpRegistration,
  execFileAgyRunner,
} from "../../src/providers/antigravity/mcp-registration.js";

/**
 * Audit finding F10: every CMM-owned `agy mcp` CLI call must be bounded by a
 * finite timeout and maxBuffer and fail closed, without ever using a shell.
 * The fixture is a real child process, so this exercises execFileSync directly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "helpers", "fake-agy-cli.js");
const NODE = process.execPath;
const LAUNCHER = "/repo/dist/bridge/mcp-bridge-launcher.js";
const SHORT_TIMEOUT_MS = 500;
// Only the intentional hang case uses SHORT_TIMEOUT_MS. All other real-child
// assertions get a longer finite test deadline so suite load cannot turn
// a functional/maxBuffer assertion into a timeout race.
const NON_HANG_TIMEOUT_MS = 5_000;
const SMALL_MAX_BUFFER_BYTES = 64 * 1024;

chmodSync(FIXTURE, 0o755);

function setMode(mode: string): void {
  process.env.FAKE_AGY_CLI_MODE = mode;
}

afterEach(() => {
  delete process.env.FAKE_AGY_CLI_MODE;
});

describe("agy mcp CLI operations are bounded and fail closed", () => {
  it("bounds a hanging agy mcp CLI call by timeout", () => {
    setMode("hang");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: SHORT_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });

    const started = Date.now();
    const outcome = runner(["mcp", "list"]);
    const elapsed = Date.now() - started;

    expect(outcome.failure).toBe("timeout");
    expect(outcome.status === 0).toBe(false);
    expect(elapsed).toBeLessThan(10_000);

    let thrown: unknown;
    try {
      ensureAntigravityMcpRegistration({
        agyPath: FIXTURE,
        command: NODE,
        args: [LAUNCHER],
        run: runner,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).code).toBe("provider_unavailable");
    console.log("ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS");
    console.log("ANTIGRAVITY_MCP_CLI_FAILURE_FAIL_CLOSED=PASS");
  }, 20_000);

  it("bounds oversized stdout by maxBuffer", () => {
    setMode("oversize-stdout");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: NON_HANG_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });
    const outcome = runner(["mcp", "list"]);
    expect(outcome.failure).toBe("max_buffer");
    expect(outcome.status === 0).toBe(false);
    console.log("ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS");
  });

  it("bounds oversized stderr by maxBuffer", () => {
    setMode("oversize-stderr");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: NON_HANG_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });
    const outcome = runner(["mcp", "list"]);
    expect(outcome.failure).toBe("max_buffer");
  });

  it("fails closed on a nonzero exit and never leaks the raw output", () => {
    setMode("exit-nonzero");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: NON_HANG_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });
    const outcome = runner(["mcp", "list"]);
    expect(outcome.status).toBe(3);

    let thrown: unknown;
    try {
      ensureAntigravityMcpRegistration({
        agyPath: FIXTURE,
        command: NODE,
        args: [LAUNCHER],
        run: runner,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).message).toContain("MCP store unavailable");
  });

  it("runs a normal list and a normal add through the real CLI runner", () => {
    setMode("normal-list");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: NON_HANG_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });
    const listed = runner(["mcp", "list"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("No MCP servers configured.\n");

    setMode("normal-add");
    const added = runner(["mcp", "add", "cmm-qoder-tools", NODE, LAUNCHER]);
    expect(added.status).toBe(0);
    expect(added.stdout).toContain("cmm-qoder-tools");
  });

  it("passes argv literally and never invokes a shell", () => {
    setMode("argv-echo");
    const runner = execFileAgyRunner(FIXTURE, {
      timeoutMs: NON_HANG_TIMEOUT_MS,
      maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    });
    const dangerous = "; touch /tmp/cmm-canary-pwned ; $(whoami) `id`";
    const argv = ["mcp", "add", "cmm-qoder-tools", "/bin/echo a b", dangerous];
    const outcome = runner(argv);
    expect(outcome.status).toBe(0);
    expect(JSON.parse(outcome.stdout)).toEqual(argv);
    console.log("ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS");
  });
});
