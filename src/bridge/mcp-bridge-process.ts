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
