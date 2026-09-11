import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeControlServer, type BridgeToolRequest } from "../../bridge/control-ipc.js";
import {
  BridgeSessionRegistry,
  SESSION_SELECTOR_ENV,
  type BridgeSessionDescriptor,
} from "../../bridge/session-registry.js";
import { DeferredToolBroker, createPublicToolCallId } from "../../core/deferred-tool-broker.js";
import { BoundedQueue } from "../../core/bounded-queue.js";
import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel, RouterTool } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { assertNoPaygFallback } from "../../security/payg-guard.js";
import {
  AGY_PATH,
  CHILD_TERMINATION_GRACE_MS,
  CappedTextBuffer,
  FORBIDDEN_PAYG_VARS,
  GLOBAL_SETTINGS_PATH,
  MAX_AGY_NDJSON_LINE_BYTES,
  MAX_AGY_STDERR_DIAGNOSTIC_BYTES,
  MAX_AGY_STDOUT_DIAGNOSTIC_BYTES,
  RealAgyRunner,
  assertAccountOnlySettings,
  buildAgyChildEnv,
  readGlobalSettingsState,
  terminateChild,
  type AgyRunner,
  type AgyRunResult,
} from "./process-client.js";
import {
  ensureAntigravityMcpRegistration,
  execFileAgyRunner,
  type AgyRunner as AgyCliRunner,
} from "./mcp-registration.js";

export {
  AGY_PATH,
  FORBIDDEN_PAYG_VARS,
  GLOBAL_SETTINGS_PATH,
  buildAgyChildEnv,
  readGlobalSettingsState,
};

function enforceAccountOnlySettings(): void {
  const state = readGlobalSettingsState();
  try {
    assertAccountOnlySettings(state);
  } catch (error) {
    throw new RouterError(
      "provider_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const PRINT_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 30_000;

/**
 * Effort vocabulary accepted by `agy --effort` (verified against agy 1.2.1).
 * The Gemini slugs already fix their level in the model id; only the
 * adjustable routes forward a caller-supplied level.
 */
export const AGY_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type AgyEffortLevel = (typeof AGY_EFFORT_LEVELS)[number];

const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_RESIDUE_PATTERN = /\[1m/;

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

function isCleanSlug(slug: string): boolean {
  if (!slug || slug.length === 0 || slug.length > 200) return false;
  if (ANSI_RESIDUE_PATTERN.test(slug)) return false;
  if (/[\u001b\u009b]/.test(slug)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return false;
  return true;
}

export interface ParsedModel {
  slug: string;
  displayName: string;
}

export function parseAgyModelsOutput(stdout: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const seen = new Set<string>();
  const clean = stripAnsi(stdout);
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s{2,}|\t/);
    const first = fields[0]?.trim() ?? "";
    if (!first) continue;
    if (/^(available|models|name|slug|id)\b/i.test(first)) continue;
    // The first column must be exactly one slug: reject lines where the
    // slug column itself contains internal whitespace (malformed output).
    if (/\s/.test(first)) continue;
    const slug = first;
    if (!isCleanSlug(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const displayName = line.slice(line.indexOf(slug) + slug.length).trim() || slug;
    models.push({ slug, displayName });
  }
  return models;
}

function ensureNeutralCwd(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
}

function verifyNoPaygInChildEnv(env: Record<string, string>): void {
  for (const key of FORBIDDEN_PAYG_VARS) {
    if (env[key] !== undefined) {
      throw new RouterError(
        "provider_protocol_error",
        `PAYG variable leaked into agy child environment: ${key}`,
      );
    }
  }
}

function mapAgyFailureToRouterError(
  result: AgyRunResult,
  context: string,
): RouterError {
  const combined = `${result.stderr}\n${result.stdout}`.slice(0, 2000);
  const lowered = combined.toLowerCase();
  if (
    lowered.includes("not logged") ||
    lowered.includes("please login") ||
    lowered.includes("login required") ||
    lowered.includes("no valid authentication") ||
    lowered.includes("unauthenticated")
  ) {
    return new RouterError(
      "provider_auth_required",
      `Antigravity account authentication required: ${context}`,
    );
  }
  if (
    lowered.includes("quota") ||
    lowered.includes("exhausted") ||
    lowered.includes("usage limit") ||
    lowered.includes("plan quota")
  ) {
    return new RouterError(
      "provider_quota_exhausted",
      `Antigravity plan quota exhausted: ${context}`,
    );
  }
  if (lowered.includes("rate limit") || lowered.includes("rate_limited")) {
    return new RouterError("provider_rate_limited", `Antigravity rate limited: ${context}`);
  }
  if (
    lowered.includes("no longer available") ||
    lowered.includes("select a valid model") ||
    lowered.includes("unknown model") ||
    lowered.includes("invalid model") ||
    lowered.includes("could not resolve")
  ) {
    return new RouterError("unknown_model", `Unknown Antigravity model: ${context}`);
  }
  if (result.error && /timed out|ETIMEDOUT/i.test(result.error.message)) {
    return new RouterError("provider_timeout", `Antigravity request timed out: ${context}`);
  }
  if (result.signal) {
    return new RouterError(
      "provider_timeout",
      `Antigravity process terminated by signal ${result.signal}: ${context}`,
    );
  }
  return new RouterError(
    "provider_protocol_error",
    `Antigravity failure (${context}): ${combined.slice(0, 300)}`,
  );
}

interface StreamParseResult {
  textDeltas: string[];
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
  } | undefined;
  completed: boolean;
  finishReason: "stop" | "tool_calls" | "length";
}

function extractTextFromStepUpdate(event: Record<string, unknown>): string[] {
  const deltas: string[] = [];
  const stack: unknown[] = [event.step_update ?? event];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.text_delta === "string" && record.text_delta.length > 0) {
        deltas.push(record.text_delta);
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  return deltas;
}

export function parseAgyStreamJson(stdout: string): StreamParseResult {
  const textDeltas: string[] = [];
  let usage: StreamParseResult["usage"];
  let completed = false;
  let finishReason: StreamParseResult["finishReason"] = "stop";

  const lines = stdout.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new RouterError(
        "provider_protocol_error",
        `Malformed Antigravity stream-json line: ${line.slice(0, 200)}`,
      );
    }
    // Official envelope: {"event": "<type>", "<type>": {...}}
    const type = typeof envelope.event === "string" ? envelope.event : envelope.type;
    const event =
      type !== undefined && typeof envelope[type as string] === "object" && envelope[type as string] !== null
        ? (envelope[type as string] as Record<string, unknown>)
        : envelope;
    if (type === "step_update") {
      for (const delta of extractTextFromStepUpdate(event)) {
        textDeltas.push(delta);
      }
      const usageField = (event.usage ?? envelope.usage) as unknown;
      if (usageField && typeof usageField === "object" && !usage) {
        const u = usageField as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        usage = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningTokens: num(u.reasoning_tokens ?? u.thinking_tokens),
          cacheReadTokens: num(u.cache_read_tokens),
        };
      }
    } else if (type === "result") {
      completed = true;
      const statusRaw = event.status ?? envelope.status;
      const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
      if (status === "interrupted" || status === "canceled" || status === "cancelled") {
        finishReason = "stop";
      } else if (
        (typeof event.terminationReason === "string" &&
          /max_steps|max_tokens|length/i.test(event.terminationReason)) ||
        (typeof envelope.terminationReason === "string" &&
          /max_steps|max_tokens|length/i.test(envelope.terminationReason))
      ) {
        finishReason = "length";
      }
      const usageField = event.usage ?? envelope.usage;
      if (usageField && typeof usageField === "object") {
        const u = usageField as Record<string, unknown>;
        const num = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        usage = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningTokens: num(u.reasoning_tokens ?? u.thinking_tokens),
          cacheReadTokens: num(u.cache_read_tokens),
        };
      }
      const response = event.response ?? envelope.response;
      if (typeof response === "string" && response.length > 0 && textDeltas.length === 0) {
        textDeltas.push(response);
      }
    }
  }

  return { textDeltas, usage, completed, finishReason };
}

/**
 * Serialize full Router conversation semantics into the single headless
 * prompt. agy exposes only a textual prompt interface, so role boundaries
 * use deterministic delimiters in original order: system instructions,
 * every user turn, every assistant turn, tool results as labelled user
 * text. No repository context is injected; no credentials; the serialized
 * prompt is never logged (only its length is observable in argv).
 */
export function serializeConversationForHeadlessPrompt(
  messages: Array<{ role: string; content: string | null; toolCallId?: string }>,
): string {
  const sections: string[] = [];
  for (const message of messages) {
    const text = message.content ?? "";
    if (!text) continue;
    if (message.role === "system") {
      sections.push(`[SYSTEM]\n${text}`);
    } else if (message.role === "assistant") {
      sections.push(`[ASSISTANT]\n${text}`);
    } else if (message.role === "tool") {
      const label =
        typeof message.toolCallId === "string"
          ? `[USER: tool_result ${message.toolCallId}]\n${text}`
          : `[USER: tool_result]\n${text}`;
      sections.push(label);
    } else {
      sections.push(`[USER]\n${text}`);
    }
  }
  return sections.join("\n\n");
}

export interface InferenceRunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Reports the pid of the spawned agy process. The Router uses it as the
   * per-run selector that correlates exactly one MCP launcher with one Router
   * session. Must be called synchronously during spawn.
   */
  onSpawn?: ((pid: number) => void) | undefined;
  /** Extra environment for the agy child (never PAYG variables). */
  extraEnv?: Record<string, string> | undefined;
}

export interface InferenceRunner {
  runInference(args: string[], options: InferenceRunOptions): Promise<AgyRunResult>;
  streamInference(
    args: string[],
    options: InferenceRunOptions,
    onEvent: (event: ParsedStreamEvent) => void,
  ): Promise<AgyRunResult>;
}

/**
 * Bounded async queue bridging the subprocess callback into the adapter's
 * async-iterator flow. Parsed NDJSON events are consumable the moment they
 * arrive — never held until process exit. Bounded so a misbehaving provider
 * cannot grow the queue without limit.
 *
 * Overflow is a TERMINAL protocol condition, not a silent drop: a bounded
 * queue that discards protocol state would be a correctness hole. On overflow
 * the queue atomically discards buffered events, refuses all further provider
 * events, records one bounded protocol error, wakes the consumer and invokes
 * `onOverflow` so the adapter can abort the exact provider run.
 */
class StreamEventQueue {
  private events: ParsedStreamEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private overflowed = false;
  private overflowError: RouterError | undefined;

  constructor(
    private readonly maxSize = MAX_STREAM_EVENTS,
    private readonly onOverflow?: (() => void) | undefined,
  ) {}

  push(event: ParsedStreamEvent): boolean {
    if (this.closed) return false;
    if (this.events.length >= this.maxSize) {
      this.enterOverflow();
      return false;
    }
    this.events.push(event);
    const waiter = this.waiters.shift();
    waiter?.();
    return true;
  }

  private enterOverflow(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    this.overflowError = new RouterError(
      "provider_protocol_error",
      "Antigravity stream event queue overflowed; refusing to silently drop protocol state",
    );
    this.events.length = 0;
    this.closed = true;
    try {
      this.onOverflow?.();
    } catch {
      // The overflow verdict is delivered through the queue regardless.
    }
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** True once the bounded queue refused an event and entered overflow. */
  didOverflow(): boolean {
    return this.overflowed;
  }

  /** The single bounded overflow protocol error (valid once overflowed). */
  overflowProtocolError(): RouterError {
    return (
      this.overflowError ??
      new RouterError(
        "provider_protocol_error",
        "Antigravity stream event queue overflowed; refusing to silently drop protocol state",
      )
    );
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async next(): Promise<ParsedStreamEvent | null> {
    for (;;) {
      const event = this.events.shift();
      if (event) return event;
      if (this.closed) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export interface ParsedStreamEvent {
  kind: "text" | "usage" | "completed" | "protocolError";
  texts?: string[];
  terminalResponse?: boolean;
  usage?: NonNullable<StreamParseResult["usage"]>;
  finishReason?: StreamParseResult["finishReason"];
  error?: RouterError;
}

/**
 * Feed one NDJSON line through the stream parser and emit incremental
 * ParsedStreamEvents. Shared by the live runner and unit-test doubles so
 * partial lines, multi-line chunks, and malformed JSON behave identically.
 */
export function feedStreamLine(
  line: string,
  emit: (event: ParsedStreamEvent) => void,
): { terminal: boolean } {
  const trimmed = line.trim();
  if (!trimmed) return { terminal: false };
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    emit({
      kind: "protocolError",
      error: new RouterError(
        "provider_protocol_error",
        `Malformed Antigravity stream-json line: ${trimmed.slice(0, 200)}`,
      ),
    });
    return { terminal: true };
  }
  const type = typeof envelope.event === "string" ? envelope.event : envelope.type;
  const event =
    type !== undefined && typeof envelope[type as string] === "object" && envelope[type as string] !== null
      ? (envelope[type as string] as Record<string, unknown>)
      : envelope;
  if (type === "step_update") {
    const texts = extractTextFromStepUpdate(event);
    if (texts.length > 0) emit({ kind: "text", texts });
    const usageField = (event.usage ?? envelope.usage) as unknown;
    if (usageField && typeof usageField === "object") {
      const u = usageField as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      emit({
        kind: "usage",
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningTokens: num(u.reasoning_tokens ?? u.thinking_tokens),
          cacheReadTokens: num(u.cache_read_tokens),
        },
      });
    }
    return { terminal: false };
  }
  if (type === "result") {
    const statusRaw = event.status ?? envelope.status;
    const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : "";
    let finishReason: StreamParseResult["finishReason"] = "stop";
    if (
      (typeof event.terminationReason === "string" &&
        /max_steps|max_tokens|length/i.test(event.terminationReason)) ||
      (typeof envelope.terminationReason === "string" &&
        /max_steps|max_tokens|length/i.test(envelope.terminationReason))
    ) {
      finishReason = "length";
    }
    void status;
    const usageField = event.usage ?? envelope.usage;
    if (usageField && typeof usageField === "object") {
      const u = usageField as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      emit({
        kind: "usage",
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          reasoningTokens: num(u.reasoning_tokens ?? u.thinking_tokens),
          cacheReadTokens: num(u.cache_read_tokens),
        },
      });
    }
    const response = event.response ?? envelope.response;
    // A terminal text-bearing result with no prior deltas still surfaces.
    if (typeof response === "string" && response.length > 0) {
      emit({ kind: "text", texts: [response], terminalResponse: true });
    }
    emit({ kind: "completed", finishReason });
    return { terminal: true };
  }
  return { terminal: false };
}

export interface SpawnInferenceRunnerOptions {
  /** Maximum bytes of one unterminated NDJSON line before failing closed. */
  maxNdjsonLineBytes?: number | undefined;
  /** Bounded stdout diagnostic retention (error mapping only). */
  maxStdoutDiagnosticBytes?: number | undefined;
  /** Bounded stderr diagnostic retention (error mapping only). */
  maxStderrDiagnosticBytes?: number | undefined;
  /** Bounded grace period between SIGINT and SIGKILL for the provider child. */
  terminationGraceMs?: number | undefined;
}

export class SpawnInferenceRunner implements InferenceRunner {
  private readonly maxNdjsonLineBytes: number;
  private readonly maxStdoutDiagnosticBytes: number;
  private readonly maxStderrDiagnosticBytes: number;
  private readonly terminationGraceMs: number;

  constructor(
    private readonly agyPath: string = AGY_PATH,
    options: SpawnInferenceRunnerOptions = {},
  ) {
    this.maxNdjsonLineBytes = options.maxNdjsonLineBytes ?? MAX_AGY_NDJSON_LINE_BYTES;
    this.maxStdoutDiagnosticBytes =
      options.maxStdoutDiagnosticBytes ?? MAX_AGY_STDOUT_DIAGNOSTIC_BYTES;
    this.maxStderrDiagnosticBytes =
      options.maxStderrDiagnosticBytes ?? MAX_AGY_STDERR_DIAGNOSTIC_BYTES;
    this.terminationGraceMs = options.terminationGraceMs ?? CHILD_TERMINATION_GRACE_MS;
  }

  async runInference(
    args: string[],
    options: InferenceRunOptions,
  ): Promise<AgyRunResult> {
    return await this.streamInference(args, options, () => undefined);
  }

  async streamInference(
    args: string[],
    options: InferenceRunOptions,
    onEvent: (event: ParsedStreamEvent) => void,
  ): Promise<AgyRunResult> {
    return await new Promise<AgyRunResult>((resolve) => {
      const child = spawn(this.agyPath, args, {
        cwd: options.cwd,
        env: buildAgyChildEnv(options.extraEnv),
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Report the exact provider process synchronously so the Router can
      // publish its per-run rendezvous descriptor before the MCP handshake.
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
      let timedOut = false;
      // Provider-controlled byte accumulation is capped: diagnostics never
      // grow with provider lifetime and a single oversize NDJSON line fails
      // the run closed instead of being buffered without bound.
      const stdoutBuf = new CappedTextBuffer(this.maxStdoutDiagnosticBytes);
      const stderrBuf = new CappedTextBuffer(this.maxStderrDiagnosticBytes);
      let lineBuffer = "";
      let settled = false;
      let lineOverflowed = false;
      let terminationPromise: Promise<"exited" | "killed"> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        options.signal.removeEventListener("abort", onAbort);
      };
      const finish = (partial: Partial<AgyRunResult>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          status: null,
          signal: null,
          stdout: stdoutBuf.value(),
          stderr: stderrBuf.value(),
          ...partial,
        });
      };
      // One shared termination path for timeout, AbortSignal, oversize-line
      // fail-closed and any caller-driven abort. Every edge therefore gets the
      // same SIGINT -> bounded grace -> SIGKILL escalation.
      const requestTermination = (): Promise<"exited" | "killed"> => {
        terminationPromise ??= terminateChild(child, this.terminationGraceMs);
        return terminationPromise;
      };
      const failClosedOversizeLine = (): void => {
        if (lineOverflowed) return;
        lineOverflowed = true;
        lineBuffer = "";
        onEvent({
          kind: "protocolError",
          error: new RouterError(
            "provider_protocol_error",
            `Antigravity stream-json line exceeded ${this.maxNdjsonLineBytes} bytes`,
          ),
        });
        void requestTermination();
      };
      const onAbort = (): void => {
        // Bounded fallback: even if the provider never reports close, the run
        // settles after the termination verdict so cleanup cannot hang.
        void requestTermination().then(() => {
          finish({ signal: "SIGKILL" });
        });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stdoutBuf.push(text);
        if (lineOverflowed) return;
        lineBuffer += text;
        const parts = lineBuffer.split("\n");
        lineBuffer = parts.pop() ?? "";
        for (const part of parts) {
          if (Buffer.byteLength(part, "utf8") > this.maxNdjsonLineBytes) {
            failClosedOversizeLine();
            return;
          }
          if (options.signal.aborted) return;
          feedStreamLine(part, onEvent);
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > this.maxNdjsonLineBytes) {
          failClosedOversizeLine();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf.push(chunk.toString("utf-8"));
      });
      child.on("error", (error: Error) => {
        finish({ error });
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (!lineOverflowed && lineBuffer.trim()) {
          if (Buffer.byteLength(lineBuffer, "utf8") <= this.maxNdjsonLineBytes) {
            feedStreamLine(lineBuffer, onEvent);
          }
          lineBuffer = "";
        }
        finish({
          status: code,
          signal,
          // A timeout keeps the same bounded termination path but must still be
          // reported as a timeout once the child has actually exited.
          ...(timedOut
            ? { error: new Error(`agy print timed out after ${options.timeoutMs}ms`) }
            : {}),
        });
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        void requestTermination();
      }, options.timeoutMs);
    });
  }
}

/**
 * Finite lifetime for a parked tool session; the broker entry expires on the
 * same bound so a session whose continuation never arrives cannot leak its agy
 * process, control socket, or session descriptor.
 */
const DEFAULT_AGY_SESSION_TTL_MS = 120_000;

/**
 * Maximum simultaneously parked provider tool sessions. A second concurrent
 * MCP tools/call on one session is refused: the split HTTP round-trip supports
 * exactly one parked call per provider session.
 */
const DEFAULT_MAX_LIVE_TOOL_SESSIONS = 64;
const MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION = 1;
/** Bounded size of the parsed-event hand-off queue for one agy run. */
const MAX_STREAM_EVENTS = 4096;

/** Dedicated, CMM Router-owned MCP server name. Never a user-chosen name. */
export const ANTIGRAVITY_MCP_SERVER_NAME = "cmm-qoder-tools";

export type McpRegistrar = (
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
) => void;

/** Absolute path to the compiled external MCP bridge entry point. */
export function defaultAntigravityBridgeEntryPath(): string {
  return fileURLToPath(new URL("../../bridge/mcp-bridge-process.js", import.meta.url));
}

/** Absolute path to the compiled MCP launcher registered with `agy mcp add`. */
export function defaultAntigravityBridgeLauncherPath(): string {
  return fileURLToPath(new URL("../../bridge/mcp-bridge-launcher.js", import.meta.url));
}

/** Qoder tool definitions as the external MCP bridge exposes them. */
export function antigravityBridgeToolDefinitions(
  tools: RouterTool[],
): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    inputSchema: tool.function.parameters ?? {},
  }));
}

/** Bounded hand-off queue for racing tool calls against agy events. */
type AsyncQueue<T> = BoundedQueue<T>;

/**
 * A live agy run held across the split HTTP interaction while its external MCP
 * handler is parked waiting for Qoder's result. The Router keeps draining the
 * SAME run on the follow-up request — no new agy process is spawned.
 */
interface AgyToolSession {
  requestId: string;
  sessionId: string;
  cwd: string;
  queue: StreamEventQueue;
  queuePromise: Promise<ParsedStreamEvent | null> | undefined;
  toolCalls: BoundedQueue<BridgeToolRequest>;
  toolCallPromise: Promise<BridgeToolRequest> | undefined;
  control: BridgeControlServer;
  unregister: () => void;
  abortController: AbortController;
  resultPromise: Promise<AgyRunResult>;
  result: AgyRunResult | undefined;
  runError: unknown;
  terminalSeen: boolean;
  terminalFinish: StreamParseResult["finishReason"];
  protocolError: RouterError | undefined;
  usageYielded: boolean;
  parkedRequestId: string | undefined;
  publicToolCallId: string | undefined;
  /** True once this session has parked a call: no second call is accepted. */
  gate: { parked: boolean };
  /** Bounded lifetime for a parked session whose continuation never arrives. */
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the session has reached a terminal state (cleanup ran). */
  terminated: boolean;
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = "google" as const;
  private activeRequests = new Map<string, { abort: () => void; cwd: string }>();
  private runner: InferenceRunner;
  private modelsRunner: AgyRunner;
  private readonly agyPath: string;
  /**
   * Router-owned bounded pending state shared with the other adapters. The
   * cross-request correlation is keyed by a Router-generated public tool id.
   */
  private readonly broker: DeferredToolBroker;
  private readonly bridgeCommand: string;
  private readonly bridgeEntryPath: string;
  private readonly bridgeLauncherPath: string;
  /** Test override for MCP registration; production uses the reconciler. */
  private readonly mcpRegistrar: McpRegistrar | undefined;
  /** Injectable `agy` CLI runner for MCP registration reconciliation. */
  private readonly mcpRunner: AgyCliRunner;
  /** Live agy runs held open while an external MCP tool call is parked. */
  private readonly toolSessions = new Map<string, AgyToolSession>();
  /** Bounded per-run rendezvous registry (selector = owning agy pid). */
  private readonly registry: BridgeSessionRegistry;
  private readonly sessionTtlMs: number;
  private readonly maxLiveSessions: number;
  /** Bounded parsed-event queue size for one agy run (overflow is terminal). */
  private readonly maxStreamEvents: number;
  /** Live tool sessions keyed by the Router request that currently drives them. */
  private readonly sessionsByRequest = new Map<string, AgyToolSession>();
  /** The CMM-owned MCP server is registered once, never per request. */
  private mcpRegistered = false;

  constructor(
    runner?: InferenceRunner,
    modelsRunner?: AgyRunner,
    options: {
      agyPath?: string | undefined;
      broker?: DeferredToolBroker | undefined;
      bridgeCommand?: string | undefined;
      bridgeEntryPath?: string | undefined;
      bridgeLauncherPath?: string | undefined;
      mcpRegistrar?: McpRegistrar | undefined;
      mcpRunner?: AgyCliRunner | undefined;
      registry?: BridgeSessionRegistry | undefined;
      sessionTtlMs?: number | undefined;
      maxLiveSessions?: number | undefined;
      maxStreamEvents?: number | undefined;
    } = {},
  ) {
    this.agyPath = options.agyPath ?? AGY_PATH;
    this.runner = runner ?? new SpawnInferenceRunner(this.agyPath);
    this.modelsRunner = modelsRunner ?? new RealAgyRunner(this.agyPath);
    this.broker = options.broker ?? new DeferredToolBroker();
    this.registry = options.registry ?? new BridgeSessionRegistry();
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_AGY_SESSION_TTL_MS;
    this.maxLiveSessions = options.maxLiveSessions ?? DEFAULT_MAX_LIVE_TOOL_SESSIONS;
    this.maxStreamEvents = options.maxStreamEvents ?? MAX_STREAM_EVENTS;
    this.bridgeCommand = options.bridgeCommand ?? process.execPath;
    this.bridgeEntryPath = options.bridgeEntryPath ?? defaultAntigravityBridgeEntryPath();
    this.bridgeLauncherPath = options.bridgeLauncherPath ?? defaultAntigravityBridgeLauncherPath();
    this.mcpRegistrar = options.mcpRegistrar;
    this.mcpRunner = options.mcpRunner ?? execFileAgyRunner(this.agyPath);
  }

  /** Live Antigravity tool sessions (test/diagnostic accessor). */
  activeToolSessions(): number {
    return this.toolSessions.size;
  }

  /** Bounded per-run rendezvous state (test/diagnostic accessor). */
  liveRendezvousSessions(): number {
    return this.registry.liveCount();
  }

  maxRendezvousSessions(): number {
    return this.registry.maxLiveSessions();
  }

  buildInferenceArgs(upstreamSlug: string, prompt: string, effort?: string): string[] {
    // `agy` only accepts low|medium|high. The Gemini slugs already encode their
    // level in the model id, so a caller-supplied effort is forwarded only for
    // the adjustable models and only when it is inside agy's vocabulary.
    const agyEffort =
      effort !== undefined && AGY_EFFORT_LEVELS.includes(effort as AgyEffortLevel)
        ? effort
        : undefined;
    return [
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--model",
      upstreamSlug,
      ...(agyEffort !== undefined ? ["--effort", agyEffort] : []),
      "--mode",
      "plan",
      "--sandbox",
      "--print-timeout",
      "120s",
    ];
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    void signal;
    // Account-only spending gate: fail closed BEFORE any spawn that could
    // consume quota. Never modifies the settings file.
    enforceAccountOnlySettings();
    const cwd = mkdtempSync(join(tmpdir(), "cmm-antigravity-discovery-"));
    ensureNeutralCwd(cwd);
    try {
      const env = buildAgyChildEnv();
      assertNoPaygFallback(env);
      verifyNoPaygInChildEnv(env);

      let result: AgyRunResult;
      try {
        result = this.modelsRunner.run(["models"], { cwd, timeoutMs: MODELS_TIMEOUT_MS });
      } catch (error) {
        throw new RouterError(
          "provider_unavailable",
          `Failed to spawn agy: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result.error && /ENOENT/.test(result.error.message)) {
        throw new RouterError("provider_unavailable", "agy CLI not found");
      }
      if (result.status !== 0) {
        throw mapAgyFailureToRouterError(result, "agy models");
      }

      const parsed = parseAgyModelsOutput(result.stdout);
      if (parsed.length === 0) {
        throw new RouterError(
          "provider_protocol_error",
          "Antigravity model discovery returned no usable models",
        );
      }

      return parsed.map((m) => ({
        id: `google/${m.slug}`,
        provider: "google" as const,
        upstreamModel: m.slug,
        displayName: m.displayName,
        // Qoder-owned tools traverse the external MCP bridge; agy's native
        // mutation tools (run_command/replace_file_content/write_to_file) are
        // never used for them and native execution stays disabled.
        capability: "CHAT_AND_TOOLS" as const,
      }));
    } finally {
      // Discovery temp dirs must not accumulate on a long-running router.
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; discovery results are already delivered.
      }
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    void signal;
    try {
      await this.discoverModels(signal);
      return { status: "ready", detail: "Antigravity account authentication verified" };
    } catch (error) {
      if (error instanceof RouterError) {
        if (error.code === "provider_auth_required") {
          return { status: "auth_required", detail: error.message };
        }
        if (error.code === "provider_unavailable") {
          return { status: "unavailable", detail: error.message };
        }
        return { status: "degraded", detail: error.message };
      }
      return { status: "unavailable", detail: String(error) };
    }
  }

  /**
   * Register the CMM-owned MCP server, reconciling against the durable `agy`
   * state rather than trusting an in-memory flag: after a Router restart, or
   * after an external edit, the persisted entry is read back and converged onto
   * exactly one canonical, secret-free `cmm-qoder-tools` registration.
   */
  private ensureMcpServerRegistered(): void {
    if (this.mcpRegistered) return;
    if (this.mcpRegistrar !== undefined) {
      this.mcpRegistrar(ANTIGRAVITY_MCP_SERVER_NAME, this.bridgeCommand, [
        this.bridgeLauncherPath,
      ], {});
      this.mcpRegistered = true;
      return;
    }
    ensureAntigravityMcpRegistration({
      agyPath: this.agyPath,
      command: this.bridgeCommand,
      args: [this.bridgeLauncherPath],
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      run: this.mcpRunner,
    });
    this.mcpRegistered = true;
  }

  private usageEventFor(
    usage: NonNullable<StreamParseResult["usage"]>,
    session: AgyToolSession,
  ): RouterEvent | null {
    if (session.usageYielded) return null;
    session.usageYielded = true;
    return {
      type: "usage",
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    } as RouterEvent;
  }

  /**
   * Terminate a live agy run and release every Router-side resource.
   *
   * Order is deliberate and race-free:
   *   1. stop the TTL timer
   *   2. abort the live agy process (SIGINT with SIGKILL escalation)
   *   3. reject/close the pending bridge request
   *   4. broker scope cleanup
   *   5. remove the per-run rendezvous descriptor
   *   6. close the control channel
   *   7. remove the per-run temp cwd
   *   8. session map cleanup
   */
  private async closeToolSession(session: AgyToolSession): Promise<void> {
    if (session.terminated) return;
    session.terminated = true;
    if (session.ttlTimer !== undefined) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = undefined;
    }
    // Terminate the exact live provider process; Router cleanup alone must not
    // leave an in-flight agy run behind.
    try {
      session.abortController.abort();
    } catch {
      // An already-aborted controller needs no further action.
    }
    if (session.parkedRequestId !== undefined) {
      session.control.reject(session.parkedRequestId, "provider run terminated");
      session.parkedRequestId = undefined;
    }
    if (session.publicToolCallId !== undefined) {
      this.toolSessions.delete(session.publicToolCallId);
      session.publicToolCallId = undefined;
    }
    this.sessionsByRequest.delete(session.requestId);
    this.broker.cancelScope({ provider: "google", sessionId: session.sessionId });
    session.unregister();
    await session.control.close().catch(() => undefined);
    try {
      rmSync(session.cwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the result was already delivered.
    }
  }

  /** Verdict for a settled agy run, mirroring the non-tool path exactly. */
  private *runVerdict(session: AgyToolSession, signal: AbortSignal): Generator<RouterEvent> {
    if (signal.aborted || session.abortController.signal.aborted) return;
    if (session.runError !== undefined) {
      const error: unknown = session.runError;
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError(
                "provider_unavailable",
                error instanceof Error ? error.message : String(error),
              ),
      };
      return;
    }
    if (session.protocolError) {
      yield { type: "error", error: session.protocolError };
      return;
    }
    const settled = session.result;
    if (!settled) {
      yield {
        type: "error",
        error: new RouterError("provider_unavailable", "Antigravity run settled without a result"),
      };
      return;
    }
    if (settled.error && /timed out/i.test(settled.error.message)) {
      yield { type: "error", error: new RouterError("provider_timeout", "Antigravity print timed out") };
      return;
    }
    if (settled.error && /ENOENT/.test(settled.error.message)) {
      yield { type: "error", error: new RouterError("provider_unavailable", "agy CLI not found") };
      return;
    }
    if (settled.status !== 0) {
      yield { type: "error", error: mapAgyFailureToRouterError(settled, "agy --print") };
      return;
    }
    if (!session.terminalSeen) {
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Antigravity stream ended without terminal result event",
        ),
      };
      return;
    }
    yield { type: "completed", finishReason: session.terminalFinish };
  }

  /**
   * Terminal stream-overflow verdict: abort the exact provider run, release
   * every Router-side resource, and surface the bounded protocol error exactly
   * once. A successful completion is never emitted after overflow.
   */
  private async *failOverflow(session: AgyToolSession): AsyncGenerator<RouterEvent> {
    const error = session.protocolError ?? session.queue.overflowProtocolError();
    session.protocolError = error;
    await this.closeToolSession(session);
    yield { type: "error", error };
  }

  /** Park a Qoder-owned tool call and keep the agy run alive. */
  private async *parkAgyToolCall(
    session: AgyToolSession,
    request: BridgeToolRequest,
  ): AsyncIterable<RouterEvent> {
    if (session.gate.parked) {
      session.control.reject(request.id, "concurrent tool calls are not supported");
      await this.closeToolSession(session);
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Concurrent Antigravity MCP tool calls are not supported",
        ),
      };
      return;
    }
    if (this.toolSessions.size >= this.maxLiveSessions) {
      session.control.reject(request.id, "too many live provider tool sessions");
      await this.closeToolSession(session);
      yield {
        type: "error",
        error: new RouterError(
          "provider_rate_limited",
          "Live provider tool sessions are at capacity; refusing another parked call",
        ),
      };
      return;
    }
    const publicId = createPublicToolCallId("google");
    session.gate.parked = true;
    session.parkedRequestId = request.id;
    session.publicToolCallId = publicId;
    try {
      this.broker.createPendingCall<AgyToolSession>(
        {
          consumer: "qoder",
          provider: "google",
          sessionId: session.sessionId,
          toolCallId: publicId,
          publicToolCallId: publicId,
        },
        this.sessionTtlMs,
        undefined,
        session,
      );
    } catch (error) {
      session.gate.parked = false;
      session.parkedRequestId = undefined;
      session.publicToolCallId = undefined;
      session.control.reject(request.id, "router could not park the tool call");
      await this.closeToolSession(session);
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_protocol_error", "Router could not park the tool call"),
      };
      return;
    }
    this.toolSessions.set(publicId, session);
    const timer = setTimeout(() => {
      void this.closeToolSession(session);
    }, this.sessionTtlMs);
    if (typeof timer.unref === "function") timer.unref();
    session.ttlTimer = timer;
    yield {
      type: "tool_call_delta",
      index: 0,
      id: publicId,
      name: request.name,
      argumentsDelta: JSON.stringify(request.input ?? {}),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  /**
   * Drain a live tool-capable agy run, racing parsed stream events against
   * parked bridge tool calls. On a tool call the run is left alive and the
   * current HTTP exchange ends with finishReason "tool_calls".
   */
  private async *drainAgySession(
    session: AgyToolSession,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    // A session that parked a call must survive this drain (the continuation
    // arrives on a later request); every other exit terminates the provider run.
    let parkedHere = false;
    try {
      while (true) {
        // Terminal overflow takes precedence over the abort it caused: the
        // provider run is terminated and one bounded protocol error surfaced.
        // No successful completion is emitted after overflow.
        if (session.queue.didOverflow()) {
          yield* this.failOverflow(session);
          return;
        }
        if (signal.aborted || session.abortController.signal.aborted) {
          return;
        }
        session.queuePromise ??= session.queue.next();
        session.toolCallPromise ??= session.toolCalls.next();
        const outcome = await Promise.race([
          session.queuePromise.then((e) => ({ kind: "event" as const, e })),
          session.toolCallPromise.then((tc) => ({ kind: "tool" as const, tc })),
        ]);
        if (outcome.kind === "tool") {
          session.toolCallPromise = undefined;
          parkedHere = true;
          yield* this.parkAgyToolCall(session, outcome.tc);
          return;
        }
        session.queuePromise = undefined;
        const event = outcome.e;
        if (event === null) {
          await session.resultPromise;
          if (session.queue.didOverflow()) {
            yield* this.failOverflow(session);
            return;
          }
          yield* this.runVerdict(session, signal);
          return;
        }
        if (event.kind === "text" && event.texts) {
          for (const text of event.texts) {
            if (signal.aborted || session.abortController.signal.aborted) return;
            yield { type: "text_delta", text };
          }
        } else if (event.kind === "usage" && event.usage) {
          const usageEvent = this.usageEventFor(event.usage, session);
          if (usageEvent) yield usageEvent;
        } else if (event.kind === "completed") {
          session.terminalSeen = true;
          session.terminalFinish = event.finishReason ?? "stop";
        } else if (event.kind === "protocolError" && event.error && !session.protocolError) {
          session.protocolError = event.error;
        }
      }
    } finally {
      // Guaranteed cleanup even when the consumer stops iterating at the
      // terminal event instead of draining the generator to completion.
      if (!parkedHere) await this.closeToolSession(session);
    }
  }

  /** Start and drain a tool-capable agy run (external MCP bridge path). */
  private async *runToolSession(
    request: RouterRequest,
    signal: AbortSignal,
    args: string[],
    cwd: string,
    abortController: AbortController,
  ): AsyncIterable<RouterEvent> {
    const sessionId = request.requestId;
    const toolCalls = new BoundedQueue<BridgeToolRequest>(MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION);
    // The gate closes as soon as this session parks a call, so a second
    // concurrent tools/call is refused instead of sitting unanswered.
    const gate = { parked: false };
    let sessionRef: AgyToolSession | undefined;
    const control = await BridgeControlServer.listen({
      onToolCall: (toolRequest) => {
        if (gate.parked || !toolCalls.tryPush(toolRequest)) {
          control.reject(toolRequest.id, "concurrent tool calls are not supported");
        }
      },
      // A dead MCP bridge while the provider waits must fail the parked session
      // closed immediately rather than at TTL.
      onDisconnect: () => {
        if (sessionRef !== undefined) void this.closeToolSession(sessionRef);
      },
    });
    try {
      this.ensureMcpServerRegistered();
    } catch (error) {
      await control.close().catch(() => undefined);
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_unavailable", String(error)),
      };
      return;
    }

    // Terminal overflow aborts the exact provider run; the drain loop then
    // surfaces the bounded protocol error exactly once.
    const queue = new StreamEventQueue(this.maxStreamEvents, () => {
      try {
        abortController.abort();
      } catch {
        // An already-aborted controller needs no further action.
      }
    });
    // The agy pid is the per-run selector. It is reported synchronously by the
    // runner during spawn, so the Router can publish the descriptor for THIS
    // run only — never a global "find whichever session is live".
    let agyPid: number | undefined;
    const extraEnv: Record<string, string> = { [SESSION_SELECTOR_ENV]: sessionId };
    // The merged child environment must still contain no PAYG variable.
    verifyNoPaygInChildEnv(buildAgyChildEnv(extraEnv));
    let runPromise: Promise<AgyRunResult>;
    try {
      runPromise = this.runner.streamInference(
        args,
        {
          cwd,
          timeoutMs: PRINT_TIMEOUT_MS,
          signal: abortController.signal,
          extraEnv,
          onSpawn: (pid) => {
            agyPid = pid;
          },
        },
        (event: ParsedStreamEvent) => queue.push(event),
      );
    } catch (error) {
      await control.close().catch(() => undefined);
      throw error;
    }
    if (agyPid === undefined) {
      // Without the exact provider pid there is no deterministic correlation;
      // refuse rather than fall back to an ambiguous selection.
      abortController.abort();
      await control.close().catch(() => undefined);
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Antigravity runner did not report the provider process id",
        ),
      };
      return;
    }

    let unregister: () => void;
    try {
      const descriptor: BridgeSessionDescriptor = {
        sessionId,
        agyPid,
        socketPath: control.socketPath,
        token: control.token,
        tools: antigravityBridgeToolDefinitions(request.tools),
      };
      unregister = this.registry.register(descriptor);
    } catch (error) {
      abortController.abort();
      await runPromise.catch(() => undefined);
      await control.close().catch(() => undefined);
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_protocol_error", "Router could not publish the bridge session"),
      };
      return;
    }

    runPromise.then(
      () => queue.close(),
      () => queue.close(),
    );

    const session: AgyToolSession = {
      requestId: request.requestId,
      sessionId,
      cwd,
      queue,
      queuePromise: undefined,
      toolCalls,
      toolCallPromise: undefined,
      control,
      unregister,
      abortController,
      resultPromise: runPromise,
      result: undefined,
      runError: undefined,
      terminalSeen: false,
      terminalFinish: "stop",
      protocolError: undefined,
      usageYielded: false,
      parkedRequestId: undefined,
      publicToolCallId: undefined,
      gate,
      ttlTimer: undefined,
      terminated: false,
    };
    sessionRef = session;
    this.sessionsByRequest.set(request.requestId, session);
    runPromise.then(
      (value) => {
        session.result = value;
      },
      (error: unknown) => {
        session.runError = error;
      },
    );
    try {
      yield* this.drainAgySession(session, signal);
    } finally {
      // A session that PARKED a call stays bound to the request that parked it:
      // the provider is still waiting for Qoder's result, so an explicit
      // cancellation of that request must reach the exact live agy run. A
      // normal tool_calls response is not a cancellation (the HTTP layer only
      // cancels a reply that closed before reaching a terminal outcome), and
      // closeToolSession removes the binding once the run terminates.
      const bound = this.sessionsByRequest.get(request.requestId);
      if (bound === undefined || bound.terminated || bound.parkedRequestId === undefined) {
        this.sessionsByRequest.delete(request.requestId);
      }
    }
  }

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    // No temp dir exists yet: every early return below happens BEFORE any
    // filesystem allocation, so nothing can leak on validation paths.
    try {
      // Account-only spending gate: fail closed BEFORE spawning inference.
      enforceAccountOnlySettings();
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_unavailable", String(error)),
      };
      return;
    }
    const env = buildAgyChildEnv();
    try {
      assertNoPaygFallback(env);
      verifyNoPaygInChildEnv(env);
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_protocol_error", String(error)),
      };
      return;
    }

    // Follow-up carrying Qoder's executed tool result: release the parked
    // external MCP handler and keep draining the SAME agy run. No new agy
    // process is spawned and no history is reconstructed.
    const toolResults = request.messages.filter(
      (message) => message.role === "tool" && typeof message.toolCallId === "string",
    );
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const publicId = result.toolCallId as string;
        const claim = this.broker.claimByPublicToolCallId<AgyToolSession>(publicId);
        if (claim.outcome !== "resolved" || !claim.context) continue;
        const session = claim.context;
        this.toolSessions.delete(publicId);
        session.publicToolCallId = undefined;
        // Rebind the session to THIS request so a cancellation of the
        // continuation reaches the exact same live agy run.
        this.sessionsByRequest.delete(session.requestId);
        session.requestId = request.requestId;
        this.sessionsByRequest.set(request.requestId, session);
        if (session.parkedRequestId !== undefined) {
          const delivered = session.control.resolve(session.parkedRequestId, result.content ?? "");
          session.parkedRequestId = undefined;
          // A completed round-trip reopens the SAME live agy run for the next
          // SEQUENTIAL tool request. Parallel unresolved calls are still
          // refused by the gate until this point.
          if (delivered) session.gate.parked = false;
        }
        try {
          yield* this.drainAgySession(session, signal);
        } catch (error) {
          yield {
            type: "error",
            error:
              error instanceof RouterError
                ? error
                : new RouterError("provider_protocol_error", String(error)),
          };
        } finally {
          // Keep the binding while the provider is parked waiting for Qoder's
          // next result so this exact request can still be cancelled; a
          // terminated session is already unbound by closeToolSession.
          const bound = this.sessionsByRequest.get(request.requestId);
          if (bound === undefined || bound.terminated || bound.parkedRequestId === undefined) {
            this.sessionsByRequest.delete(request.requestId);
          }
        }
        return;
      }
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Antigravity tool result does not match any pending Qoder tool call",
        ),
      };
      return;
    }

    const prompt = serializeConversationForHeadlessPrompt(request.messages);
    if (!prompt.trim()) {
      yield {
        type: "error",
        error: new RouterError("invalid_request", "Antigravity request has no user prompt"),
      };
      return;
    }

    const args = this.buildInferenceArgs(
      request.model.upstreamModel,
      prompt,
      request.reasoningEffort,
    );
    if (args.includes("--dangerously-skip-permissions")) {
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Refusing to run agy with --dangerously-skip-permissions",
        ),
      };
      return;
    }

    // Temp cwd is created only here — after every validation gate — and the
    // try/finally below owns ALL exits from this point (success, protocol
    // error, spawn failure, abort, timeout).
    const cwd = mkdtempSync(join(tmpdir(), "cmm-antigravity-run-"));
    ensureNeutralCwd(cwd);

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.activeRequests.set(request.requestId, {
      abort: () => abortController.abort(),
      cwd,
    });

    // Tool-capable run: register the CMM-owned MCP server and hold the agy run
    // open while an external MCP tools/call is parked for Qoder. The bridge
    // performs transport only; agy's native mutation tools stay unused.
    if (request.tools.length > 0) {
      try {
        yield* this.runToolSession(request, signal, args, cwd, abortController);
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.activeRequests.delete(request.requestId);
      }
      return;
    }

    try {
      // True incremental streaming: the subprocess callback pushes parsed
      // events into a queue, and this loop drains the queue WHILE the child
      // is still running. Deltas yield before process exit; completion is
      // only emitted for an observed terminal result event — never
      // synthesized from process close.
      const queue = new StreamEventQueue(this.maxStreamEvents, () => {
        try {
          abortController.abort();
        } catch {
          // An already-aborted controller needs no further action.
        }
      });
      let terminalSeen = false;
      let terminalFinish: StreamParseResult["finishReason"] = "stop";
      let protocolError: RouterError | undefined;
      let usageYielded = false;

      const toUsageEvent = (
        usage: NonNullable<StreamParseResult["usage"]>,
      ): RouterEvent | null => {
        if (usageYielded) return null;
        usageYielded = true;
        return {
          type: "usage",
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.reasoningTokens !== undefined
            ? { reasoningTokens: usage.reasoningTokens }
            : {}),
          ...(usage.cacheReadTokens !== undefined
            ? { cacheReadTokens: usage.cacheReadTokens }
            : {}),
        } as RouterEvent;
      };

      const onEvent = (event: ParsedStreamEvent): void => {
        queue.push(event);
      };

      const runPromise = this.runner.streamInference(
        args,
        {
          cwd,
          timeoutMs: PRINT_TIMEOUT_MS,
          signal: abortController.signal,
        },
        onEvent,
      );
      // Close the queue when the subprocess settles so the drain loop ends.
      // A rejection is handled below; closing here only ends iteration.
      runPromise.then(
        () => queue.close(),
        () => queue.close(),
      );

      let runError: unknown;
      let result: AgyRunResult | undefined;
      const resultPromise = runPromise.then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          runError = error;
        },
      );

      // Drain parsed events as they arrive — including while runPromise is
      // still pending. Terminal bookkeeping only; process-exit verdicts are
      // evaluated after the runner settles.
      let drainDone = false;
      while (!drainDone) {
        // Overflow outranks the abort it caused so the protocol error is still
        // surfaced instead of being mistaken for an ordinary cancellation.
        if (queue.didOverflow()) break;
        if (signal.aborted || abortController.signal.aborted) return;
        const event = await queue.next();
        if (event === null) {
          drainDone = true;
          break;
        }
        if (event.kind === "text" && event.texts) {
          for (const text of event.texts) {
            if (signal.aborted || abortController.signal.aborted) return;
            yield { type: "text_delta", text };
          }
        } else if (event.kind === "usage" && event.usage) {
          const usageEvent = toUsageEvent(event.usage);
          if (usageEvent) yield usageEvent;
        } else if (event.kind === "completed") {
          terminalSeen = true;
          terminalFinish = event.finishReason ?? "stop";
        } else if (event.kind === "protocolError" && event.error && !protocolError) {
          protocolError = event.error;
        }
      }

      await resultPromise;

      // Terminal overflow outranks the abort it caused: surface exactly one
      // bounded protocol error and never emit a successful completion after.
      if (queue.didOverflow() && protocolError === undefined) {
        protocolError = queue.overflowProtocolError();
      }

      if (protocolError !== undefined) {
        yield { type: "error", error: protocolError };
        return;
      }

      if (runError !== undefined) {
        if (signal.aborted || abortController.signal.aborted) return;
        const error: unknown = runError;
        if (error instanceof RouterError) {
          yield { type: "error", error };
        } else {
          yield {
            type: "error",
            error: new RouterError(
              "provider_unavailable",
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
        return;
      }

      if (signal.aborted || abortController.signal.aborted) {
        return;
      }

      const settled = result as AgyRunResult | undefined;
      if (!settled) {
        yield {
          type: "error",
          error: new RouterError("provider_unavailable", "Antigravity run settled without a result"),
        };
        return;
      }

      if (settled.error && /timed out/i.test(settled.error.message)) {
        yield {
          type: "error",
          error: new RouterError("provider_timeout", "Antigravity print timed out"),
        };
        return;
      }
      if (settled.error && /ENOENT/.test(settled.error.message)) {
        yield {
          type: "error",
          error: new RouterError("provider_unavailable", "agy CLI not found"),
        };
        return;
      }
      if (settled.status !== 0) {
        yield { type: "error", error: mapAgyFailureToRouterError(settled, "agy --print") };
        return;
      }

      if (!terminalSeen) {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            "Antigravity stream ended without terminal result event",
          ),
        };
        return;
      }

      yield { type: "completed", finishReason: terminalFinish };
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.activeRequests.delete(request.requestId);
      // Per-request temp dirs must not accumulate on a long-running router.
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; inference results are already delivered.
      }
    }
  }

  async cancel(requestId: string): Promise<void> {
    // A request that currently drives a live tool session (parked awaiting
    // Qoder, or resuming after a result) is terminated through the SAME agy
    // AbortController, so post-result cancellation reaches the exact provider
    // process. A parked session with no request bound to it is left to its TTL:
    // the HTTP layer closes the reply socket after the normal tool_calls
    // response, which is not a cancellation.
    const session = this.sessionsByRequest.get(requestId);
    if (session !== undefined) {
      await this.closeToolSession(session);
      return;
    }
    const active = this.activeRequests.get(requestId);
    if (!active) return;
    try {
      active.abort();
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
}

export function sha256HexFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function snapshotRepoTree(root: string): Map<string, string> {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const hashes = new Map<string, string>();
  for (const file of files) {
    try {
      hashes.set(file, sha256HexFile(join(root, file)));
    } catch {
      // ignore unreadable files
    }
  }
  return hashes;
}

export function writeCanaryFiles(dir: string): { file1: string; file2: string } {
  mkdirSync(dir, { recursive: true });
  const file1 = join(dir, "canary-file-1.txt");
  const file2 = join(dir, "canary-file-2.txt");
  writeFileSync(file1, "Antigravity canary content 1");
  writeFileSync(file2, "Antigravity canary content 2");
  return { file1, file2 };
}
