import { spawn, type ChildProcess } from "node:child_process";

/**
 * Protocol-faithful fake Claude Agent SDK transport.
 *
 * The real adapter passes `options.mcpServers` to the SDK and the SDK owns the
 * provider-facing MCP stdio child. This fake consumes that SAME configuration:
 * it spawns the configured command with the configured environment, speaks real
 * MCP stdio (`initialize` -> `notifications/initialized` -> `tools/list` ->
 * `tools/call`), and only emits its final assistant text AFTER the tools/call
 * response has arrived.
 *
 * The emitted final text embeds the exact tool-result string, so a test can
 * prove the provider continuation is caused by the Router/Qoder-produced result
 * rather than by any test-side release gate.
 */

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface FakeClaudeSdkOptions {
  /** Declared tool to invoke once discovered through tools/list. */
  toolName: string;
  toolArguments: Record<string, unknown>;
  /** Text emitted before the tool call (streamed delta). */
  preText?: string;
  /** Prefix used when deriving the final text from the tool result. */
  finalPrefix?: string;
  /** Bounded wait for each MCP request. */
  requestTimeoutMs?: number;
  /**
   * Optional gate awaited AFTER the tool result arrives and BEFORE the final
   * message is emitted. Lets a test hold the provider in RESUMING state.
   */
  holdAfterResult?: (() => Promise<void>) | undefined;
}

export interface FakeClaudeSdk {
  queryFn: (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncGenerator<unknown>;
  /** True once the production mcpServers config was read. */
  consumedMcpConfig: () => boolean;
  /** pid of the MCP stdio child the fake SDK spawned (provider-facing owner). */
  mcpChildPid: () => number | undefined;
  /** True once the fake SDK sent tools/call over MCP stdio. */
  sentToolsCall: () => boolean;
  /** Raw MCP tools/call result text, as received over the wire. */
  mcpToolResult: () => string | undefined;
  /** Declared tool names seen in tools/list. */
  declaredTools: () => string[];
  /** True once the MCP child exited. */
  childExited: () => boolean;
  /** True once the SDK abort signal fired (provider run terminated). */
  wasAborted: () => boolean;
  /** True once the provider-facing MCP child was torn down. */
  childKilled: () => boolean;
  /** Performs initialize/tools/list without the model turn (preflight helper). */
  handshake: (options: Record<string, unknown>) => Promise<string[]>;
}

interface StdioServerConfig {
  type?: string;
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

function readStdioConfig(options: Record<string, unknown>): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const servers = options.mcpServers as Record<string, StdioServerConfig> | undefined;
  if (!servers || typeof servers !== "object") {
    throw new Error("fake SDK: production options.mcpServers is absent");
  }
  const entry = Object.values(servers)[0];
  if (!entry || typeof entry !== "object") {
    throw new Error("fake SDK: production mcpServers has no server entry");
  }
  if (entry.type !== undefined && entry.type !== "stdio") {
    throw new Error(`fake SDK: expected a stdio MCP server, got ${String(entry.type)}`);
  }
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    throw new Error("fake SDK: mcpServers stdio command is missing");
  }
  const args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [];
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object") {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return { command: entry.command, args, env };
}

/**
 * A real MCP stdio client over a child process. Used both by the fake SDK and
 * by the preflight handshake helper.
 */
class McpStdioClient {
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private exited = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number,
  ) {
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", () => {
      this.exited = true;
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error("fake SDK: MCP child exited before responding"));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (message.id === undefined || message.id === null) continue;
      const waiter = this.pending.get(String(message.id));
      if (!waiter) continue;
      this.pending.delete(String(message.id));
      if (message.error !== undefined) {
        waiter.reject(new Error(`fake SDK: MCP error ${JSON.stringify(message.error)}`));
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`fake SDK: MCP ${method} timed out`));
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  kill(): void {
    if (!this.exited) {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
    }
  }
}

function toolNamesOf(result: unknown): string[] {
  const record = result as { tools?: unknown } | undefined;
  if (!record || !Array.isArray(record.tools)) return [];
  const names: string[] = [];
  for (const entry of record.tools) {
    if (entry && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}

function firstTextOf(result: unknown): string | undefined {
  const record = result as { content?: unknown } | undefined;
  if (!record || !Array.isArray(record.content)) return undefined;
  for (const part of record.content) {
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

export function createFakeClaudeSdk(options: FakeClaudeSdkOptions): FakeClaudeSdk {
  let consumedMcpConfig = false;
  let childPid: number | undefined;
  let sentToolsCall = false;
  let toolResultText: string | undefined;
  let declaredToolNames: string[] = [];
  let child: ChildProcess | undefined;
  let aborted = false;
  let childKilled = false;

  const startChild = (sdkOptions: Record<string, unknown>): McpStdioClient => {
    const config = readStdioConfig(sdkOptions);
    consumedMcpConfig = true;
    child = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: config.env,
    });
    childPid = child.pid;
    return new McpStdioClient(child, options.requestTimeoutMs ?? 15000);
  };

  const handshake = async (sdkOptions: Record<string, unknown>): Promise<string[]> => {
    const client = startChild(sdkOptions);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fake-claude-sdk", version: "1.0.0" },
    });
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    declaredToolNames = toolNamesOf(listed);
    return declaredToolNames;
  };

  const queryFn = (args: { prompt: unknown; options: Record<string, unknown> }): AsyncGenerator<unknown> => {
    const abortController = args.options.abortController as AbortController | undefined;
    return (async function* () {
      const client = startChild(args.options);
      const abort = (): void => {
        aborted = true;
        childKilled = true;
        client.kill();
      };
      abortController?.signal.addEventListener("abort", abort, { once: true });

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: options.preText ?? "thinking " },
        },
      };

      try {
        if (abortController?.signal.aborted) return;
        await client.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "fake-claude-sdk", version: "1.0.0" },
        });
        client.notify("notifications/initialized");
        const listed = await client.request("tools/list");
        declaredToolNames = toolNamesOf(listed);
        if (!declaredToolNames.includes(options.toolName)) {
          throw new Error(
            `fake SDK: declared tools ${JSON.stringify(declaredToolNames)} do not include ${options.toolName}`,
          );
        }
        sentToolsCall = true;
        const callResult = await client.request("tools/call", {
          name: options.toolName,
          arguments: options.toolArguments,
        });
        // The ONLY source of the final text: the tool-result wire value.
        toolResultText = firstTextOf(callResult) ?? "";
        if (options.holdAfterResult) await options.holdAfterResult();
      } catch (error) {
        if (abortController?.signal.aborted) return;
        throw error;
      } finally {
        abortController?.signal.removeEventListener("abort", abort);
      }
      if (abortController?.signal.aborted) return;

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: `${options.finalPrefix ?? "final:"}${toolResultText ?? ""}`,
          },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 7 },
      };
    })();
  };

  return {
    queryFn,
    consumedMcpConfig: () => consumedMcpConfig,
    mcpChildPid: () => childPid,
    sentToolsCall: () => sentToolsCall,
    mcpToolResult: () => toolResultText,
    declaredTools: () => declaredToolNames,
    childExited: () => (child?.exitCode ?? null) !== null || (child?.signalCode ?? null) !== null,
    wasAborted: () => aborted,
    childKilled: () => childKilled,
    handshake,
  };
}
