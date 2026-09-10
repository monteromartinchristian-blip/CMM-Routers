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
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export function serialize(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** MCP error code for an invalid parameter, including an undeclared tool name. */
export const MCP_INVALID_PARAMS = -32602;

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

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      const id = message.id;
      const method = message.method;
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
        continue;
      }
      if (method === "notifications/initialized") continue;
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
        continue;
      }
      if (method === "tools/call") {
        const params = message.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        if (!declaredTools.has(name)) {
          // Authentication is not authorization: an undeclared tool is refused
          // here and never reaches the Router or Qoder.
          write(
            serialize({
              jsonrpc: "2.0",
              id,
              error: {
                code: MCP_INVALID_PARAMS,
                message: "undeclared tool name refused by the CMM bridge",
              },
            }),
          );
          continue;
        }
        const callId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        if (client === null) {
          write(
            serialize({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: "bridge control channel not configured" },
            }),
          );
          continue;
        }
        client.request(callId, name, params.arguments ?? {}).then(
          (text) => {
            write(
              serialize({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text }], isError: false },
              }),
            );
          },
          (error: unknown) => {
            write(
              serialize({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            );
          },
        );
        continue;
      }
      write(serialize({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method: ${method}` } }));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpBridgeProcess();
}
