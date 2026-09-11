import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MAX_MCP_STDIO_FRAME_BYTES } from "../../src/providers/claude/mcp-bridge.js";

const REPO = join(import.meta.dirname, "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");
const ENTRY = join(import.meta.dirname, "../helpers/mcp-bridge-entry.ts");

describe("provider-facing MCP bridge frame bound", () => {
  it("fails closed when an unterminated frame exceeds the bound", async () => {
    const child = spawn(TSX, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      // One oversized chunk with NO newline must not be retained.
      child.stdin.on("error", () => undefined);
      child.stdin.write("x".repeat(MAX_MCP_STDIO_FRAME_BYTES + 1024));
    });
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    console.log("MCP_BRIDGE_LIBRARY_STDIO_FRAME_BOUND=PASS");
    console.log("MCP_BRIDGE_LIBRARY_OVERSIZE_FRAME_FAIL_CLOSED=PASS");
  }, 30000);
});
