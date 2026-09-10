import { describe, expect, it, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { BridgeControlServer } from "../../src/bridge/control-ipc.js";
import {
  createMcpStdioParser,
  MAX_MCP_STDIO_FRAME_BYTES,
  MCP_INVALID_PARAMS,
} from "../../src/bridge/mcp-bridge-process.js";

const REPO = join(import.meta.dirname, "../..");
const BRIDGE_ENTRY = join(REPO, "src/bridge/mcp-bridge-process.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

interface Frame {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  error?: { code: number; message: string };
  result?: {
    content?: Array<{ type: string; text: string }>;
    tools?: Array<{ name: string }>;
    serverInfo?: { name: string };
  };
}

interface RecordedCall {
  id: string;
  name: string;
  input: unknown;
}

interface Harness {
  push: (chunk: string) => void;
  feed: (message: unknown) => void;
  frames: () => Frame[];
  calls: RecordedCall[];
  exits: number[];
  bufferedBytes: () => number;
  settle: (text: string) => void;
}

function makeHarness(
  options: { declared?: string[]; configured?: boolean } = {},
): Harness {
  const declared = options.declared ?? ["cmm_echo"];
  const writes: string[] = [];
  const calls: RecordedCall[] = [];
  const exits: number[] = [];
  let settleLast: ((text: string) => void) | null = null;
  const request =
    options.configured === false
      ? null
      : (id: string, name: string, input: unknown): Promise<string> => {
          calls.push({ id, name, input });
          return new Promise<string>((resolve) => {
            settleLast = resolve;
          });
        };
  const parser = createMcpStdioParser({
    write: (line) => writes.push(line),
    declaredTools: new Set(declared),
    tools: declared.map((name) => ({ name, inputSchema: { type: "object" } })),
    request,
    exit: (code) => exits.push(code),
  });
  return {
    push: (chunk) => parser.push(chunk),
    feed: (message) => parser.push(`${JSON.stringify(message)}\n`),
    frames: () => writes.map((line) => JSON.parse(line) as Frame),
    calls,
    exits,
    bufferedBytes: () => parser.bufferedBytes(),
    settle: (text) => {
      const pending = settleLast;
      if (pending === null) throw new Error("no parked call to settle");
      settleLast = null;
      pending(text);
    },
  };
}

function toolCall(id: unknown, params: unknown, extra: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params, ...extra };
}

const VALID_PARAMS = { name: "cmm_echo", arguments: { text: "canary" } };

/** Let queued promise callbacks (the write-after-resolve path) run. */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("MCP provider-facing stdio frame bound", () => {
  it("accepts a frame at the bound and rejects one byte past it", () => {
    expect(MAX_MCP_STDIO_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("fails closed on an oversize frame delivered across chunks with no newline", () => {
    const h = makeHarness();
    const chunk = "a".repeat(256 * 1024);
    for (let i = 0; i < 5; i += 1) h.push(chunk);

    expect(h.calls).toEqual([]);
    expect(h.bufferedBytes()).toBe(0);
    expect(h.exits.length).toBe(1);
    expect(h.exits[0]).not.toBe(0);
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.id).toBeNull();
    expect(frames[0]!.error!.code).toBe(-32700);
    expect(frames[0]!.error!.message).toMatch(/maximum size/i);
    console.log("MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=PASS");
    console.log("MCP_OVERSIZE_FRAME_FAIL_CLOSED=PASS");
    console.log("MCP_OVERSIZE_FRAME_SURFACED_TO_QODER=NONE");
  });

  it("never retains more than the bound while accumulating an unterminated frame", () => {
    const h = makeHarness();
    const chunk = "a".repeat(64 * 1024);
    for (let i = 0; i < 20; i += 1) {
      h.push(chunk);
      expect(h.bufferedBytes()).toBeLessThanOrEqual(MAX_MCP_STDIO_FRAME_BYTES);
    }
    expect(h.calls).toEqual([]);
    expect(h.exits.length).toBe(1);
  });

  it("fails closed on a single oversize line that arrives with its newline", () => {
    const h = makeHarness();
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "cmm_echo", arguments: { blob: "a".repeat(MAX_MCP_STDIO_FRAME_BYTES + 16) } },
    })}\n`;
    h.push(line);

    // The oversize line must not be accumulated/split/processed first.
    expect(h.bufferedBytes()).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.exits.length).toBe(1);
    expect(h.exits[0]).not.toBe(0);
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.error!.code).toBe(-32700);
    console.log("MCP_OVERSIZE_FRAME_SURFACED_TO_QODER=NONE");
  });

  it("treats malformed JSON as a protocol violation and terminates fail-closed", () => {
    const h = makeHarness();
    h.push("{not json\n");
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.jsonrpc).toBe("2.0");
    expect(frames[0]!.id).toBeNull();
    expect(frames[0]!.error!.code).toBe(-32700);
    expect(h.exits).toEqual([1]);
    expect(h.calls).toEqual([]);

    // A terminated session accepts nothing further.
    h.feed(toolCall(1, VALID_PARAMS));
    expect(h.calls).toEqual([]);
    expect(h.exits.length).toBe(1);
  });

  it("keeps the supported handshake and tool list intact", () => {
    const h = makeHarness();
    h.feed({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    h.feed({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    h.feed({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const frames = h.frames();
    expect(frames.length).toBe(2);
    expect(frames[0]!.id).toBe(1);
    expect(frames[0]!.result!.serverInfo!.name).toBe("cmm_qoder");
    expect(frames[1]!.result!.tools!.map((t) => t.name)).toEqual(["cmm_echo"]);
    expect(h.exits).toEqual([]);
  });
});

describe("MCP tools/call JSON-RPC identity requirements", () => {
  const adversarial: Array<{ name: string; frame: unknown; code: number; nullId: boolean }> = [
    {
      name: "missing jsonrpc",
      frame: { id: 4, method: "tools/call", params: VALID_PARAMS },
      code: -32600,
      nullId: false,
    },
    {
      name: "wrong jsonrpc version",
      frame: { jsonrpc: "1.0", id: 4, method: "tools/call", params: VALID_PARAMS },
      code: -32600,
      nullId: false,
    },
    {
      name: "missing id",
      frame: { jsonrpc: "2.0", method: "tools/call", params: VALID_PARAMS },
      code: -32600,
      nullId: true,
    },
    {
      name: "null id",
      frame: toolCall(null, VALID_PARAMS),
      code: -32600,
      nullId: true,
    },
    {
      name: "object id",
      frame: toolCall({ nested: 1 }, VALID_PARAMS),
      code: -32600,
      nullId: true,
    },
    {
      name: "boolean id",
      frame: toolCall(true, VALID_PARAMS),
      code: -32600,
      nullId: true,
    },
    {
      name: "missing params",
      frame: { jsonrpc: "2.0", id: 4, method: "tools/call" },
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "params not an object",
      frame: toolCall(4, "cmm_echo"),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "missing params.name",
      frame: toolCall(4, { arguments: {} }),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "non-string params.name",
      frame: toolCall(4, { name: 7, arguments: {} }),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "undeclared name",
      frame: toolCall(4, { name: "run_command", arguments: {} }),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "string arguments",
      frame: toolCall(4, { name: "cmm_echo", arguments: "text=canary" }),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
    {
      name: "array arguments",
      frame: toolCall(4, { name: "cmm_echo", arguments: ["canary"] }),
      code: MCP_INVALID_PARAMS,
      nullId: false,
    },
  ];

  for (const c of adversarial) {
    it(`refuses ${c.name} without reaching Qoder`, async () => {
      const h = makeHarness();
      h.feed(c.frame);
      await flushMicrotasks();
      expect(h.calls).toEqual([]);
      expect(h.exits).toEqual([]);
      const frames = h.frames();
      expect(frames.length).toBe(1);
      expect(frames[0]!.error!.code).toBe(c.code);
      if (c.nullId) expect(frames[0]!.id).toBeNull();
      else expect(frames[0]!.id).toBe(4);
    });
  }

  it("refuses a duplicate in-flight tools/call id without a second Qoder call", async () => {
    const h = makeHarness();
    h.feed(toolCall(5, VALID_PARAMS));
    h.feed(toolCall(5, VALID_PARAMS));
    expect(h.calls.length).toBe(1);
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.error!.code).toBe(-32600);
    expect(frames[0]!.id).toBe(5);
    h.settle("canary-from-qoder");
    await flushMicrotasks();
    const settled = h.frames();
    expect(settled.length).toBe(2);
    expect(settled[1]!.id).toBe(5);
    expect(settled[1]!.result!.content).toEqual([{ type: "text", text: "canary-from-qoder" }]);
  });

  it("refuses a valid-shaped tools/call when the control channel is not configured", () => {
    const h = makeHarness({ configured: false });
    h.feed(toolCall(6, VALID_PARAMS));
    expect(h.calls).toEqual([]);
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.error!.code).toBe(-32000);
    expect(frames[0]!.id).toBe(6);
  });

  it("delivers a well-formed tools/call to the control channel exactly once", async () => {
    const h = makeHarness();
    h.feed({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "cmm_echo", arguments: { text: "canary" } } });
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.name).toBe("cmm_echo");
    expect(h.calls[0]!.input).toEqual({ text: "canary" });
    expect(h.frames()).toEqual([]);

    h.settle("canary-from-qoder");
    await flushMicrotasks();
    const frames = h.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.id).toBe(7);
    expect(frames[0]!.result!.content).toEqual([{ type: "text", text: "canary-from-qoder" }]);
    expect(h.exits).toEqual([]);
    console.log("MCP_TOOL_CALL_JSONRPC_VERSION_REQUIRED=PASS");
    console.log("MCP_TOOL_CALL_JSONRPC_ID_REQUIRED=PASS");
    console.log("MCP_MALFORMED_TOOL_CALL_FAIL_CLOSED=PASS");
    console.log("MALFORMED_MCP_TOOL_CALL_SURFACED_TO_QODER=NONE");
  });

  it("defaults absent arguments to an empty object", () => {
    const h = makeHarness();
    h.feed(toolCall(8, { name: "cmm_echo" }));
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.input).toEqual({});
  });
});

describe("MCP bridge process fail-closed end to end", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("waitFor timed out");
  }

  it("terminates non-zero after an oversize provider frame", async () => {
    const child = spawn(TSX, [BRIDGE_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CMM_BRIDGE_TOOLS: JSON.stringify([{ name: "cmm_echo", inputSchema: { type: "object" } }]),
      },
    });
    children.push(child);
    const out: string[] = [];
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => out.push(chunk));
    // The bridge exits mid-stream on overflow; the remaining writes must not
    // surface as an unhandled EPIPE in the test process.
    child.stdin!.on("error", () => undefined);
    let exited: number | null = null;
    child.on("exit", (code) => {
      exited = code ?? -1;
    });

    const chunk = "a".repeat(256 * 1024);
    for (let i = 0; i < 5; i += 1) child.stdin!.write(chunk);
    await waitFor(() => exited !== null);
    expect(exited).not.toBe(0);
    const lines = out.join("").split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const frame = JSON.parse(lines[0]!) as Frame;
    expect(frame.id).toBeNull();
    expect(frame.error!.code).toBe(-32700);
  }, 30000);

  it("never parks a tools/call that lacks a JSON-RPC id", async () => {
    const parked: Array<{ id: string; name: string }> = [];
    const control = await BridgeControlServer.listen({
      onToolCall: (request) => parked.push({ id: request.id, name: request.name }),
    });
    const child = spawn(TSX, [BRIDGE_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CMM_BRIDGE_SOCKET: control.socketPath,
        CMM_BRIDGE_TOKEN: control.token,
        CMM_BRIDGE_TOOLS: JSON.stringify([{ name: "cmm_echo", inputSchema: { type: "object" } }]),
      },
    });
    children.push(child);
    const out: string[] = [];
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => out.push(chunk));
    const send = (message: object): void => {
      child.stdin!.write(`${JSON.stringify(message)}\n`);
    };

    try {
      send({ jsonrpc: "2.0", method: "tools/call", params: { name: "cmm_echo", arguments: {} } });
      await waitFor(() => out.join("").includes('"id":null'));
      const refusal = JSON.parse(
        out.join("").split("\n").find((l) => l.includes('"id":null'))!,
      ) as Frame;
      expect(refusal.error).toBeDefined();

      // Only the well-formed follow-up call may ever be parked with the Router.
      send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "cmm_echo", arguments: {} } });
      await waitFor(() => parked.length === 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(parked.length).toBe(1);
      expect(control.pendingCount()).toBe(1);
      expect(child.exitCode).toBeNull();
    } finally {
      await control.close().catch(() => undefined);
    }
  }, 30000);
});
