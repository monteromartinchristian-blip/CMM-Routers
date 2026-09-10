import { spawn, type ChildProcess } from "node:child_process";

/**
 * Protocol-faithful MULTI-STEP fake Claude Agent SDK transport.
 *
 * Like `fake-claude-sdk.ts`, this consumes the REAL production
 * `options.mcpServers` config, spawns the configured MCP stdio child, and acts
 * as an MCP client over that child. The difference is the decision procedure:
 *
 *   initialize -> tools/list -> tools/call A
 *     -> AWAIT result A through the real MCP/bridge/control wire
 *     -> ONLY THEN decide the second step, using result A
 *     -> tools/call B (arguments derived from result A)
 *     -> AWAIT result B
 *     -> emit the final assistant text DERIVED FROM BOTH results
 *
 * Causality is structural, not gated: step B cannot happen before result A has
 * arrived over the production transport, because its trigger IS that arrival
 * (the awaited `tools/call` response), and its arguments embed result A. There
 * is no `release()`/manual-final-answer hook anywhere: the emitted final text
 * is a pure function of the two wire results.
 *
 * Optional holds only DELAY the fake at well-defined points (used by
 * cancellation tests); they never supply the causal content.
 */

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Observable progress points of the multi-step run. */
export type MultiStepStage =
  | "query-started"
  | "handshake-done"
  | "tool-a-sent"
  | "concurrent-probe-settled"
  | "result-a-received"
  | "tool-b-sent"
  | "result-b-received"
  | "final-emitted";

export interface ParallelProbeOutcome {
  outcome: "resolved" | "rejected";
  text?: string;
  message?: string;
}

export interface FakeClaudeSdkMultiStepOptions {
  /** Step A: the declared tool the provider requests first. */
  toolA: { name: string; arguments: Record<string, unknown> };
  /** Step B: declared tool name requested only after result A arrived. */
  toolBName: string;
  /** Step B arguments, DERIVED from result A (structural causal link). */
  toolBArguments: (resultA: string) => Record<string, unknown>;
  /**
   * Issue a SECOND, unanswered tools/call while A is still unresolved, to prove
   * that genuinely PARALLEL calls are still refused while sequential ones work.
   * The probe's outcome is recorded, never awaited before A resolves.
   */
  concurrentProbe?: boolean;
  /** Delay before the concurrent probe is written (keeps A unresolved). */
  probeDelayMs?: number;
  /** Text emitted before the first tool call. */
  preText?: string;
  /** Prefix used when deriving the final text from both results. */
  finalPrefix?: string;
  /** Bounded wait for each MCP request. */
  requestTimeoutMs?: number;
  /** Bounded wait for a stage observation. */
  stageTimeoutMs?: number;
  /** Delay points (cancellation tests). Never supply causal content. */
  holdBeforeToolA?: (() => Promise<void>) | undefined;
  holdAfterResultA?: (() => Promise<void>) | undefined;
  holdAfterResultB?: (() => Promise<void>) | undefined;
}

export interface FakeClaudeSdkMultiStep {
  queryFn: (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncGenerator<unknown>;
  /** True once the production mcpServers config was read. */
  consumedMcpConfig: () => boolean;
  /** pid of the MCP stdio child the fake SDK spawned (provider-facing owner). */
  mcpChildPid: () => number | undefined;
  /** Declared tool names seen in tools/list. */
  declaredTools: () => string[];
  /** Number of tools/call requests the fake has written over MCP stdio. */
  toolCallCount: () => number;
  /** Raw result A text as received over the wire. */
  resultA: () => string | undefined;
  /** Raw result B text as received over the wire. */
  resultB: () => string | undefined;
  /** Final assistant text the fake emitted (derived from both results). */
  finalText: () => string | undefined;
  /** Outcome of the optional concurrent probe call. */
  concurrentProbeOutcome: () => ParallelProbeOutcome | undefined;
  /** Ordered list of stages that have been reached. */
  stages: () => MultiStepStage[];
  /** Resolves once the stage is (or already was) reached. */
  awaitStage: (stage: MultiStepStage) => Promise<void>;
  /** True once the SDK abort signal fired (provider run terminated). */
  wasAborted: () => boolean;
  /** True once the MCP child was torn down. */
  childKilled: () => boolean;
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

/** Real MCP stdio client over the child process the fake SDK owns. */
class McpStdioClient {
  private buffer = "";
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
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
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
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

export function createFakeClaudeSdkMultiStep(
  options: FakeClaudeSdkMultiStepOptions,
): FakeClaudeSdkMultiStep {
  let consumedMcpConfig = false;
  let childPid: number | undefined;
  let declaredToolNames: string[] = [];
  let toolCallCount = 0;
  let resultAText: string | undefined;
  let resultBText: string | undefined;
  let finalTextValue: string | undefined;
  let probeOutcome: ParallelProbeOutcome | undefined;
  let child: ChildProcess | undefined;
  let aborted = false;
  let childKilled = false;

  const stageOrder: MultiStepStage[] = [];
  const reached = new Set<MultiStepStage>();
  const stageWaiters = new Map<MultiStepStage, Array<() => void>>();
  const mark = (stage: MultiStepStage): void => {
    if (!reached.has(stage)) {
      reached.add(stage);
      stageOrder.push(stage);
    }
    const waiters = stageWaiters.get(stage);
    if (waiters) {
      stageWaiters.delete(stage);
      for (const resolve of waiters) resolve();
    }
  };
  const awaitStage = (stage: MultiStepStage): Promise<void> => {
    if (reached.has(stage)) return Promise.resolve();
    const timeoutMs = options.stageTimeoutMs ?? 15000;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`fake SDK: stage "${stage}" was never reached`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const list = stageWaiters.get(stage) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      stageWaiters.set(stage, list);
    });
  };

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

  const queryFn = (args: {
    prompt: unknown;
    options: Record<string, unknown>;
  }): AsyncGenerator<unknown> => {
    const abortController = args.options.abortController as AbortController | undefined;
    return (async function* () {
      mark("query-started");
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
          clientInfo: { name: "fake-claude-sdk-multistep", version: "1.0.0" },
        });
        client.notify("notifications/initialized");
        const listed = await client.request("tools/list");
        declaredToolNames = toolNamesOf(listed);
        if (!declaredToolNames.includes(options.toolA.name)) {
          throw new Error(
            `fake SDK: declared tools ${JSON.stringify(declaredToolNames)} do not include ${options.toolA.name}`,
          );
        }
        mark("handshake-done");
        // A hold only DELAYS the fake here (cancellation tests observe the
        // state BEFORE step A); it never supplies step content.
        if (options.holdBeforeToolA) await options.holdBeforeToolA();
        if (abortController?.signal.aborted) return;

        // ---- STEP A: provider requests the first Qoder tool ----
        toolCallCount += 1;
        mark("tool-a-sent");
        const callA = client.request("tools/call", {
          name: options.toolA.name,
          arguments: options.toolA.arguments,
        });
        let probe: Promise<void> | undefined;
        if (options.concurrentProbe === true) {
          // Deliberately unanswered first call: this second call is concurrent
          // with A, not sequential. It must be refused by the Router.
          probe = (async () => {
            await new Promise((r) => setTimeout(r, options.probeDelayMs ?? 40));
            try {
              const text = await client.request("tools/call", {
                name: options.toolA.name,
                arguments: { text: "concurrent-probe" },
              });
              probeOutcome = { outcome: "resolved", text: firstTextOf(text) ?? "" };
            } catch (error) {
              probeOutcome = { outcome: "rejected", message: (error as Error).message };
            }
            mark("concurrent-probe-settled");
          })();
        }
        // The ONLY trigger for step B: result A arriving over the real wire.
        const rawA = await callA;
        resultAText = firstTextOf(rawA) ?? "";
        mark("result-a-received");
        if (probe) await probe;
        if (resultAText.length === 0) {
          throw new Error("fake SDK: result A was empty; refusing to proceed");
        }
        if (abortController?.signal.aborted) return;
        if (options.holdAfterResultA) await options.holdAfterResultA();
        if (abortController?.signal.aborted) return;

        // ---- STEP B: only reachable after result A; args embed result A ----
        toolCallCount += 1;
        mark("tool-b-sent");
        const rawB = await client.request("tools/call", {
          name: options.toolBName,
          arguments: options.toolBArguments(resultAText),
        });
        resultBText = firstTextOf(rawB) ?? "";
        mark("result-b-received");
        if (abortController?.signal.aborted) return;
        if (options.holdAfterResultB) await options.holdAfterResultB();
        if (abortController?.signal.aborted) return;
      } catch (error) {
        if (abortController?.signal.aborted) return;
        throw error;
      } finally {
        abortController?.signal.removeEventListener("abort", abort);
      }
      if (abortController?.signal.aborted) return;

      // Final text is a pure function of BOTH wire results.
      finalTextValue = `${options.finalPrefix ?? "final:"}A=${resultAText}|B=${resultBText}`;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: finalTextValue },
        },
      };
      mark("final-emitted");
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
    declaredTools: () => declaredToolNames,
    toolCallCount: () => toolCallCount,
    resultA: () => resultAText,
    resultB: () => resultBText,
    finalText: () => finalTextValue,
    concurrentProbeOutcome: () => probeOutcome,
    stages: () => [...stageOrder],
    awaitStage,
    wasAborted: () => aborted,
    childKilled: () => childKilled,
  };
}
