import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BridgeControlClient, BridgeControlServer } from "../../src/bridge/control-ipc.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

function readPerm(mode: number): string {
  return (mode & 0o777).toString(8);
}

describe("bridge-control IPC", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it("creates a user-only socket and round-trips a parked request", async () => {
    const parked: Array<{ id: string; name: string; input: unknown }> = [];
    const server = await BridgeControlServer.listen({
      onToolCall: (request) => parked.push(request),
    });
    closers.push(() => server.close());

    expect(existsSync(server.socketPath)).toBe(true);
    expect(readPerm(statSync(server.socketPath).mode)).toBe("600");
    expect(readPerm(statSync(join(server.socketPath, "..")).mode)).toBe("700");

    const client = new BridgeControlClient(server.socketPath, server.token);
    const promise = client.request("req-1", "cmm_echo", { text: "canary" });
    await waitFor(() => parked.length === 1, 4000);
    expect(parked).toMatchObject([{ id: "req-1", name: "cmm_echo", input: { text: "canary" } }]);
    expect(server.pendingCount()).toBe(1);

    expect(server.resolve("req-1", "canary-executed-by-qoder")).toBe(true);
    await expect(promise).resolves.toBe("canary-executed-by-qoder");
    expect(server.pendingCount()).toBe(0);
    console.log("CLAUDE_BRIDGE_CONTROL_IPC=PASS");
  });

  it("rejects an unauthenticated connection", async () => {
    const server = await BridgeControlServer.listen({ onToolCall: () => undefined });
    closers.push(() => server.close());
    const client = new BridgeControlClient(server.socketPath, "wrong-token");
    await expect(client.request("req-x", "cmm_echo", {})).rejects.toThrow();
    expect(server.pendingCount()).toBe(0);
    console.log("BRIDGE_CONTROL_TOKEN_REQUIRED=PASS");
  });

  it("removes the socket directory on close", async () => {
    const server = await BridgeControlServer.listen({ onToolCall: () => undefined });
    const dir = join(server.socketPath, "..");
    await server.close();
    expect(existsSync(dir)).toBe(false);
    console.log("BRIDGE_CONTROL_CLEANUP=PASS");
  });
});

interface BridgeHarness {
  server: BridgeControlServer;
  send: (msg: object) => void;
  lines: () => string[];
}

/** Poll until `predicate` holds; avoids fixed sleeps that flake under load. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

async function withBridge(
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>,
  onToolCall: (request: { id: string; name: string; input: unknown }) => void,
  run: (harness: BridgeHarness) => Promise<void>,
): Promise<void> {
  const server = await BridgeControlServer.listen({ onToolCall });
  const child = spawn(TSX, [BRIDGE_ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      CMM_BRIDGE_SOCKET: server.socketPath,
      CMM_BRIDGE_TOKEN: server.token,
      CMM_BRIDGE_TOOLS: JSON.stringify(tools),
    },
  });
  const out: string[] = [];
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => out.push(chunk));
  try {
    await run({
      server,
      send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
      lines: () => out.join("").split("\n").filter((line) => line.trim()),
    });
  } finally {
    child.kill();
    await server.close();
  }
}

describe("external stdio MCP bridge process", () => {
  it("serves the MCP handshake and the Qoder tool list", async () => {
    await withBridge(
      [{ name: "cmm_echo", inputSchema: { type: "object" } }],
      () => undefined,
      async ({ send, lines }) => {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        await waitFor(() => lines().length >= 2);
        const init = JSON.parse(lines()[0]!) as { result: { serverInfo: { name: string } } };
        expect(init.result.serverInfo.name).toBe("cmm_qoder");
        const list = JSON.parse(lines()[1]!) as {
          result: { tools: Array<{ name: string; description: string }> };
        };
        expect(list.result.tools[0]!.name).toBe("cmm_echo");
        console.log("CLAUDE_EXTERNAL_BRIDGE_PROCESS=PASS");
        console.log("CLAUDE_TOOL_DECLARATION=PASS");
      },
    );
  });

  it("parks tools/call and returns only the Router-supplied result", async () => {
    const parked: Array<{ id: string; name: string; input: unknown }> = [];
    await withBridge(
      [{ name: "cmm_echo", inputSchema: { type: "object" } }],
      (request) => parked.push(request),
      async ({ server, send, lines }) => {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        send({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "cmm_echo", arguments: { text: "canary" } },
        });
        // The bridge must NOT answer before the Router supplies a result: the
        // request is parked with the Router, nothing is executed locally.
        await waitFor(() => parked.length === 1);
        expect(lines().some((line) => line.includes('"id":7'))).toBe(false);
        expect(parked[0]).toMatchObject({ name: "cmm_echo", input: { text: "canary" } });

        expect(server.resolve(parked[0]!.id, "canary-from-qoder")).toBe(true);
        await waitFor(() => lines().some((line) => line.includes('"id":7')));
        const response = lines().find((line) => line.includes('"id":7'));
        expect(response).toBeDefined();
        const parsed = JSON.parse(response!) as {
          result: { content: Array<{ type: string; text: string }> };
        };
        expect(parsed.result.content).toEqual([{ type: "text", text: "canary-from-qoder" }]);
        console.log("CLAUDE_QODER_RESULT_CORRELATED=PASS");
        console.log("CLAUDE_NATIVE_TOOL_EXECUTION=NONE");
      },
    );
  });
});
