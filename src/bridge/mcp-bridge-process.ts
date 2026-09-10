import { BridgeControlClient } from "./control-ipc.js";

/**
 * External stdio MCP bridge process.
 *
 * This process is provider-facing: Claude / Antigravity launch it as an MCP
 * server. It exposes the Qoder-owned tool schemas and, on `tools/call`, parks
 * the request over the Router-facing bridge-control IPC and waits for the
 * already-produced Qoder result. It performs NO filesystem, shell, or edit
 * side effect of any kind — transport only.
 *
 * Authorization: `tools/call` accepts ONLY names in the declared tool set. The
 * MCP transport being authenticated is not authorization to call an arbitrary
 * function. An undeclared name fails closed with an MCP error and is never
 * forwarded to the Router, so no Router/Qoder executable tool call is surfaced
 * and no broker entry is created.
 *
 * Request identity: `tools/call` is a request/response operation. It must carry
 * `jsonrpc: "2.0"`, a string/number `id` and an object `params` BEFORE any
 * Broker/Router/Qoder surface is touched. A frame that fails any check is
 * refused with a JSON-RPC error and creates no Router/broker/tool state; a
 * notification-shaped `tools/call` is never treated as a notification.
 *
 * Configuration is supplied via environment so the Router can start it
 * request-scoped without touching any global provider configuration:
 *   CMM_BRIDGE_SOCKET       Unix socket path of the control channel
 *   CMM_BRIDGE_TOKEN        per-session authentication token
 *   CMM_BRIDGE_SERVER_NAME  MCP server name (default: cmm_qoder)
 *   CMM_BRIDGE_TOOLS        JSON array of {name, description?, inputSchema}
 */

export interface BridgeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Maximum size of one provider-facing MCP stdio frame (one newline-delimited
 * JSON-RPC message), in bytes. 1 MiB is deliberately the SAME bound as the
 * Router-side control frame bound (`MAX_CONTROL_FRAME_BYTES` in control-ipc.ts)
 * and the tool-result bound (`MAX_TOOL_RESULT_BYTES` in
 * core/tool-result-bound.ts): a provider must not be able to grow bridge memory
 * past what the layers behind it would already refuse.
 */
export const MAX_MCP_STDIO_FRAME_BYTES = 1024 * 1024;

/** JSON-RPC parse error (malformed JSON / frame that could not be read). */
export const MCP_PARSE_ERROR = -32700;
/** JSON-RPC invalid request (missing/incorrect request identity). */
export const MCP_INVALID_REQUEST = -32600;

/**
 * Upper bound on simultaneously in-flight `tools/call` requests. The Router
 * bounds parked frames already; this is a defense-in-depth bound so a provider
 * cannot grow bridge-side bookkeeping without limit.
 */
export const MAX_INFLIGHT_TOOL_CALLS = 64;

/** Exit status used whenever the bridge terminates fail-closed. */
export const MCP_FAIL_CLOSED_EXIT_CODE = 1;

export function serialize(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** MCP error code for an invalid parameter, including an undeclared tool name. */
export const MCP_INVALID_PARAMS = -32602;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-RPC id is only usable when it is a string or a finite number. */
function isValidRequestId(value: unknown): value is string | number {
  if (typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Terminate the bridge session fail-closed. stdout to a pipe is asynchronous,
 * so wait a BOUNDED time for the already-written protocol error to flush before
 * ending the process; a blocked stdout must not hang the session. `process.exit`
 * also closes every control socket, which lets the Router release the parked
 * frames that belonged to this provider session (no leaked session state).
 */
function failClosedExit(code: number): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    process.exit(code);
  };
  const timer = setTimeout(finish, 300);
  if (typeof timer.unref === "function") timer.unref();
  process.stdout.write("", () => {
    clearTimeout(timer);
    setImmediate(finish);
  });
}

function readToolsFromEnv(): BridgeToolDefinition[] {
  const raw = process.env.CMM_BRIDGE_TOOLS;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is BridgeToolDefinition =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        typeof (entry as { inputSchema?: unknown }).inputSchema === "object",
    );
  } catch {
    return [];
  }
}

export interface McpStdioParserOptions {
  /** Writes one complete JSON-RPC line to the provider-facing stdout. */
  write: (line: string) => void;
  /** Immutable per-session declared-tool ACL. */
  declaredTools: ReadonlySet<string>;
  /** Declared tools advertised by `tools/list`. */
  tools?: readonly BridgeToolDefinition[];
  /**
   * Parks one tool call on the Router control channel. `null` when the control
   * channel is not configured; a call is then refused, never executed.
   */
  request:
    | ((controlId: string, name: string, input: unknown) => Promise<string>)
    | null;
  serverName?: string;
  /**
   * Fail-closed termination seam. Defaults to a bounded stdout flush followed
   * by `process.exit(code)`; identical behavior, injectable for tests.
   */
  exit?: (code: number) => void;
}

export interface McpStdioParser {
  /** Feed one decoded chunk of provider stdin. */
  push(chunk: string): void;
  /** Bytes currently retained for an unterminated frame (bounded). */
  bufferedBytes(): number;
}

/**
 * The exact production framing/validation path used by `startMcpBridgeProcess`.
 * Extracted so the real code path (not a test double) can be driven directly.
 *
 * Framing policy: the retained (unterminated) frame plus each incoming chunk is
 * size-checked BEFORE it is appended, so an oversize line fails closed the
 * moment it crosses the bound instead of being fully accumulated first. Node
 * delivers pipe chunks of at most ~64 KiB, so a single chunk holding many small
 * complete frames can never approach the bound; the only way to trip the check
 * is genuine accumulation, which is exactly the attack being bounded.
 *
 * Malformed-frame policy: a JSON parse failure is a protocol violation, not a
 * frame to skip. `catch { continue }` would let a provider feed garbage forever,
 * so the bridge writes a JSON-RPC parse error and terminates fail-closed
 * (non-zero) — the session is cleaned up instead of silently absorbing bytes.
 */
export function createMcpStdioParser(options: McpStdioParserOptions): McpStdioParser {
  const write = options.write;
  const declaredTools = options.declaredTools;
  const tools = options.tools ?? [];
  const request = options.request;
  const serverName = options.serverName ?? "cmm_qoder";
  const exit = options.exit ?? failClosedExit;

  let buffer = "";
  let bufferBytes = 0;
  let terminated = false;
  const inFlight = new Set<string | number>();

  const protocolError = (
    id: string | number | null,
    code: number,
    message: string,
  ): void => {
    write(serialize({ jsonrpc: "2.0", id, error: { code, message } }));
  };

  const failClosed = (code: number): void => {
    if (terminated) return;
    terminated = true;
    // Discard the retained frame state; nothing from it may be processed.
    buffer = "";
    bufferBytes = 0;
    inFlight.clear();
    exit(code);
  };

  const overflow = (): void => {
    // Fail closed on the SIZE alone: no control-channel tool request for this
    // frame, no Router/broker state, then terminate so the provider session is
    // cleaned up. The oversize frame cannot be parsed for an id safely (doing so
    // would mean retaining it), so this is reported as a parse error with a null
    // id — which is also a legal JSON-RPC id/notification id.
    protocolError(null, MCP_PARSE_ERROR, "MCP frame exceeds maximum size");
    failClosed(MCP_FAIL_CLOSED_EXIT_CODE);
  };

  const refuseToolCall = (
    id: string | number | null,
    code: number,
    message: string,
  ): void => {
    // Fail closed before any control-channel/broker/Qoder surface exists.
    protocolError(id, code, message);
  };

  const handleToolCall = (message: JsonRpcMessage): void => {
    const frameId = isValidRequestId(message.id) ? message.id : null;
    // Require the full JSON-RPC request identity BEFORE anything can execute.
    if (message.jsonrpc !== "2.0") {
      refuseToolCall(frameId, MCP_INVALID_REQUEST, 'tools/call requires jsonrpc "2.0"');
      return;
    }
    if (frameId === null) {
      // A tools/call without a valid id is NOT a notification: refuse it rather
      // than let it create an executable Qoder call with an unanswerable id.
      refuseToolCall(null, MCP_INVALID_REQUEST, "tools/call requires a string or number id");
      return;
    }
    if (!isRecord(message.params)) {
      refuseToolCall(frameId, MCP_INVALID_PARAMS, "tools/call requires object params");
      return;
    }
    const params = message.params;
    const name = typeof params.name === "string" ? params.name : null;
    if (name === null) {
      refuseToolCall(frameId, MCP_INVALID_PARAMS, "tools/call params.name must be a string");
      return;
    }
    if (!declaredTools.has(name)) {
      // Authentication is not authorization: an undeclared tool is refused
      // here and never reaches the Router or Qoder.
      refuseToolCall(
        frameId,
        MCP_INVALID_PARAMS,
        "undeclared tool name refused by the CMM bridge",
      );
      return;
    }
    // `arguments` defaults to {} only when the key is truly absent; a present
    // but wrong-typed `arguments` fails closed instead of being coerced.
    const rawArguments = params.arguments;
    let input: unknown;
    if (rawArguments === undefined) input = {};
    else if (isRecord(rawArguments)) input = rawArguments;
    else {
      refuseToolCall(
        frameId,
        MCP_INVALID_PARAMS,
        "tools/call params.arguments must be an object",
      );
      return;
    }
    if (inFlight.has(frameId)) {
      refuseToolCall(
        frameId,
        MCP_INVALID_REQUEST,
        "duplicate in-flight tools/call request id refused",
      );
      return;
    }
    if (request === null) {
      refuseToolCall(frameId, -32000, "bridge control channel not configured");
      return;
    }
    if (inFlight.size >= MAX_INFLIGHT_TOOL_CALLS) {
      refuseToolCall(
        frameId,
        MCP_INVALID_REQUEST,
        "too many in-flight tools/call requests refused",
      );
      return;
    }
    // Every check passed: only now may a Qoder-owned call be parked.
    const controlId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    inFlight.add(frameId);
    request(controlId, name, input).then(
      (text) => {
        inFlight.delete(frameId);
        write(
          serialize({
            jsonrpc: "2.0",
            id: frameId,
            result: { content: [{ type: "text", text }], isError: false },
          }),
        );
      },
      (error: unknown) => {
        inFlight.delete(frameId);
        write(
          serialize({
            jsonrpc: "2.0",
            id: frameId,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      },
    );
  };

  const handleLine = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      protocolError(null, MCP_PARSE_ERROR, "invalid JSON-RPC frame on the MCP stdio transport");
      failClosed(MCP_FAIL_CLOSED_EXIT_CODE);
      return;
    }
    if (!isRecord(message)) {
      protocolError(null, MCP_INVALID_REQUEST, "JSON-RPC frame must be an object");
      failClosed(MCP_FAIL_CLOSED_EXIT_CODE);
      return;
    }
    const frame = message as JsonRpcMessage;
    const id = frame.id;
    const method = frame.method;
    if (method === "initialize") {
      write(
        serialize({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      write(
        serialize({
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? `Qoder-owned tool ${tool.name}`,
              inputSchema: tool.inputSchema,
            })),
          },
        }),
      );
      return;
    }
    if (method === "tools/call") {
      handleToolCall(frame);
      return;
    }
    write(serialize({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method: ${method}` } }));
  };

  return {
    push(chunk: string): void {
      if (terminated) return;
      // The bound applies WHILE accumulating: as soon as the retained frame plus
      // this chunk would exceed the max we fail closed immediately, without
      // waiting for a newline and without retaining the oversize data.
      const chunkBytes = Buffer.byteLength(chunk, "utf-8");
      if (bufferBytes + chunkBytes > MAX_MCP_STDIO_FRAME_BYTES) {
        overflow();
        return;
      }
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      bufferBytes = Buffer.byteLength(buffer, "utf-8");
      for (const line of lines) {
        if (terminated) return;
        if (!line.trim()) continue;
        // A single newline-terminated line that itself exceeds the bound must
        // fail closed too, and must not be processed.
        if (Buffer.byteLength(line, "utf-8") > MAX_MCP_STDIO_FRAME_BYTES) {
          overflow();
          return;
        }
        handleLine(line);
      }
    },
    bufferedBytes(): number {
      return bufferBytes;
    },
  };
}

export function startMcpBridgeProcess(write: (line: string) => void = (line) => process.stdout.write(line)): void {
  const socketPath = process.env.CMM_BRIDGE_SOCKET;
  const token = process.env.CMM_BRIDGE_TOKEN;
  const serverName = process.env.CMM_BRIDGE_SERVER_NAME ?? "cmm_qoder";
  const tools = readToolsFromEnv();
  // Immutable per-session declared-tool ACL.
  const declaredTools = new Set(tools.map((tool) => tool.name));
  const client =
    typeof socketPath === "string" && typeof token === "string"
      ? new BridgeControlClient(socketPath, token)
      : null;

  // The parser below is the production framing/validation path; this entry point
  // only wires it to the real stdin, control channel and stdout.
  const parser = createMcpStdioParser({
    write,
    declaredTools,
    tools,
    request: client === null ? null : (controlId, name, input) => client.request(controlId, name, input),
    serverName,
  });

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    parser.push(chunk);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpBridgeProcess();
}
