import { spawn, type ChildProcess } from "node:child_process";

/**
 * Park-and-await MCP tool bridge. Exposes Qoder-requested functions as MCP
 * tools whose handler NEVER executes: it parks `{id, name, input}` in a
 * caller-supplied waiter registry and awaits the already-produced Qoder
 * result. Claude (`PreToolUse: defer` + same-session resume) and Antigravity
 * (custom stdio MCP server) share this implementation with
 * provider-tagged correlation keys.
 */

export interface BridgedToolRequest {
  id: string;
  name: string;
  input: unknown;
}

export type DeferredToolUse = BridgedToolRequest;

export interface McpBridgeOptions {
  serverName: string;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

/**
 * Maximum retained bytes for one unterminated provider-facing MCP frame. A
 * provider that streams JSON without a newline must not be able to grow this
 * buffer without limit; the bound is enforced while accumulating and the
 * transport fails closed on overflow (matching the external bridge parser and
 * the Router-side control-frame bound).
 */
export const MAX_MCP_STDIO_FRAME_BYTES = 1024 * 1024;

function readStdinLines(processLine: (line: string) => void): void {
  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    if (buffer.length + chunk.length > MAX_MCP_STDIO_FRAME_BYTES) {
      // Fail closed: never retain an unbounded provider-controlled frame.
      process.exitCode = 1;
      process.exit(1);
      return;
    }
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) processLine(line);
    }
  });
}

export function serializeMcpResponse(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function serializeMcpError(id: number | string, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Standalone stdio MCP server entry point. `awaitResult` is called with the
 * parked request and must resolve with Qoder's already-executed result text.
 * Never performs filesystem/shell/edit side effects itself.
 */
export function runMcpBridgeServer(
  options: McpBridgeOptions,
  awaitResult: (request: BridgedToolRequest) => Promise<string>,
): void {
  readStdinLines((line: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id as number | string;
    const method = message.method as string | undefined;
    if (method === "initialize") {
      process.stdout.write(
        `${serializeMcpResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: options.serverName, version: "1.0.0" },
        })}\n`,
      );
      return;
    }
    if (method === "tools/list") {
      process.stdout.write(
        `${serializeMcpResponse(id, {
          tools: options.tools.map((t) => ({
            name: t.name,
            description: t.description ?? `Qoder-owned tool ${t.name}`,
            inputSchema: t.inputSchema,
          })),
        })}\n`,
      );
      return;
    }
    if (method === "tools/call") {
      const params = message.params as Record<string, unknown>;
      const name = String(params.name ?? "");
      const args = params.arguments ?? {};
      const toolCallId = `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const request: BridgedToolRequest = { id: toolCallId, name, input: args };
      // Park-and-await: the ONLY path to a result is Qoder's execution.
      // eslint-disable-next-line no-console
      awaitResult(request).then(
        (text) => {
          process.stdout.write(
            `${serializeMcpResponse(id, { content: [{ type: "text", text }] })}\n`,
          );
        },
        (error: unknown) => {
          process.stdout.write(
            `${serializeMcpError(id, -32000, error instanceof Error ? error.message : String(error))}\n`,
          );
        },
      );
      return;
    }
    process.stdout.write(`${serializeMcpError(id, -32601, `unsupported method: ${method}`)}\n`);
  });
}

export function spawnMcpBridge(_options: McpBridgeOptions): ChildProcess {
  void _options;
  throw new Error("spawnMcpBridge is configured at deployment time via `agy mcp add`; see docs/macos-install.md");
}
