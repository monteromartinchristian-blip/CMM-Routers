import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeControlServer, type BridgeToolRequest } from "../../bridge/control-ipc.js";
import { registerBridgeSession } from "../../bridge/session-registry.js";
import { DeferredToolBroker, createPublicToolCallId } from "../../core/deferred-tool-broker.js";
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
  FORBIDDEN_PAYG_VARS,
  GLOBAL_SETTINGS_PATH,
  RealAgyRunner,
  assertAccountOnlySettings,
  buildAgyChildEnv,
  readGlobalSettingsState,
  type AgyRunner,
  type AgyRunResult,
} from "./process-client.js";

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

export interface InferenceRunner {
  runInference(
    args: string[],
    options: { cwd: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<AgyRunResult>;
  streamInference(
    args: string[],
    options: { cwd: string; timeoutMs: number; signal: AbortSignal },
    onEvent: (event: ParsedStreamEvent) => void,
  ): Promise<AgyRunResult>;
}

/**
 * Unbounded async queue bridging the subprocess callback into the adapter's
 * async-iterator flow. Parsed NDJSON events are consumable the moment they
 * arrive — never held until process exit.
 */
class StreamEventQueue {
  private events: ParsedStreamEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(event: ParsedStreamEvent): void {
    if (this.closed) return;
    this.events.push(event);
    const waiter = this.waiters.shift();
    waiter?.();
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

export class SpawnInferenceRunner implements InferenceRunner {
  constructor(private readonly agyPath: string = AGY_PATH) {}

  async runInference(
    args: string[],
    options: { cwd: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<AgyRunResult> {
    return await this.streamInference(args, options, () => undefined);
  }

  async streamInference(
    args: string[],
    options: { cwd: string; timeoutMs: number; signal: AbortSignal },
    onEvent: (event: ParsedStreamEvent) => void,
  ): Promise<AgyRunResult> {
    return await new Promise<AgyRunResult>((resolve) => {
      const child = spawn(this.agyPath, args, {
        cwd: options.cwd,
        env: buildAgyChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;
      const finish = (partial: Partial<AgyRunResult>) => {
        if (settled) return;
        settled = true;
        resolve({ status: null, signal: null, stdout, stderr, ...partial });
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGINT");
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 2000);
        finish({ error: new Error(`agy print timed out after ${options.timeoutMs}ms`) });
      }, options.timeoutMs);
      const onAbort = () => {
        try {
          child.kill("SIGINT");
        } catch {
          // ignore
        }
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stdout += text;
        lineBuffer += text;
        const parts = lineBuffer.split("\n");
        lineBuffer = parts.pop() ?? "";
        for (const part of parts) {
          if (options.signal.aborted) return;
          feedStreamLine(part, onEvent);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        finish({ error });
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        if (lineBuffer.trim()) {
          feedStreamLine(lineBuffer, onEvent);
          lineBuffer = "";
        }
        finish({ status: code, signal });
      });
    });
  }
}

/**
 * Finite lifetime for a parked tool session; the broker entry expires on the
 * same bound so a session whose continuation never arrives cannot leak its agy
 * process, control socket, or session descriptor.
 */
const AGY_SESSION_TTL_MS = 120_000;

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

/** Minimal async hand-off queue for racing tool calls against agy events. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

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
  toolCalls: AsyncQueue<BridgeToolRequest>;
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
  /** Bounded lifetime for a parked session whose continuation never arrives. */
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
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
  private readonly mcpRegistrar: McpRegistrar;
  /** Live agy runs held open while an external MCP tool call is parked. */
  private readonly toolSessions = new Map<string, AgyToolSession>();
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
    } = {},
  ) {
    this.agyPath = options.agyPath ?? AGY_PATH;
    this.runner = runner ?? new SpawnInferenceRunner(this.agyPath);
    this.modelsRunner = modelsRunner ?? new RealAgyRunner(this.agyPath);
    this.broker = options.broker ?? new DeferredToolBroker();
    this.bridgeCommand = options.bridgeCommand ?? process.execPath;
    this.bridgeEntryPath = options.bridgeEntryPath ?? defaultAntigravityBridgeEntryPath();
    this.bridgeLauncherPath = options.bridgeLauncherPath ?? defaultAntigravityBridgeLauncherPath();
    this.mcpRegistrar =
      options.mcpRegistrar ??
      ((name, command, args, env) => {
        const envFlags = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        execFileSync(this.agyPath, ["mcp", "add", ...envFlags, name, command, ...args], {
          stdio: "ignore",
        });
      });
  }

  /** Live Antigravity tool sessions (test/diagnostic accessor). */
  activeToolSessions(): number {
    return this.toolSessions.size;
  }

  buildInferenceArgs(upstreamSlug: string, prompt: string): string[] {
    return [
      "--print",
      prompt,
      "--output-format",
      "stream-json",
      "--model",
      upstreamSlug,
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

  /** Register the CMM-owned MCP server once per adapter (idempotent). */
  private ensureMcpServerRegistered(): void {
    if (this.mcpRegistered) return;
    this.mcpRegistrar(ANTIGRAVITY_MCP_SERVER_NAME, this.bridgeCommand, [
      this.bridgeLauncherPath,
    ], {});
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

  /** Release a live tool session: registration, control channel, temp dir. */
  private async closeToolSession(session: AgyToolSession): Promise<void> {
    if (session.ttlTimer !== undefined) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = undefined;
    }
    if (session.publicToolCallId !== undefined) {
      this.toolSessions.delete(session.publicToolCallId);
      this.broker.cancelScope({ provider: "google", sessionId: session.sessionId });
      session.publicToolCallId = undefined;
    }
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

  /** Park a Qoder-owned tool call and keep the agy run alive. */
  private async *parkAgyToolCall(
    session: AgyToolSession,
    request: BridgeToolRequest,
  ): AsyncIterable<RouterEvent> {
    if (session.parkedRequestId !== undefined) {
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
    const publicId = createPublicToolCallId("google");
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
        AGY_SESSION_TTL_MS,
        undefined,
        session,
      );
    } catch (error) {
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
    }, AGY_SESSION_TTL_MS);
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
    try {
      while (true) {
        if (signal.aborted || session.abortController.signal.aborted) {
          await this.closeToolSession(session);
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
          yield* this.parkAgyToolCall(session, outcome.tc);
          return;
        }
        session.queuePromise = undefined;
        const event = outcome.e;
        if (event === null) {
          await session.resultPromise;
          yield* this.runVerdict(session, signal);
          await this.closeToolSession(session);
          return;
        }
        if (event.kind === "text" && event.texts) {
          for (const text of event.texts) {
            if (signal.aborted || session.abortController.signal.aborted) {
              await this.closeToolSession(session);
              return;
            }
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
    } catch (error) {
      await this.closeToolSession(session);
      throw error;
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
    const toolCalls = new AsyncQueue<BridgeToolRequest>();
    const control = await BridgeControlServer.listen({
      onToolCall: (toolRequest) => toolCalls.push(toolRequest),
    });
    const unregister = registerBridgeSession(sessionId, {
      socketPath: control.socketPath,
      token: control.token,
      tools: antigravityBridgeToolDefinitions(request.tools),
    });
    this.ensureMcpServerRegistered();

    const queue = new StreamEventQueue();
    const runPromise = this.runner.streamInference(
      args,
      { cwd, timeoutMs: PRINT_TIMEOUT_MS, signal: abortController.signal },
      (event: ParsedStreamEvent) => queue.push(event),
    );
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
      ttlTimer: undefined,
    };
    runPromise.then(
      (value) => {
        session.result = value;
      },
      (error: unknown) => {
        session.runError = error;
      },
    );
    yield* this.drainAgySession(session, signal);
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
        if (session.parkedRequestId !== undefined) {
          session.control.resolve(session.parkedRequestId, result.content ?? "");
          session.parkedRequestId = undefined;
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

    const args = this.buildInferenceArgs(request.model.upstreamModel, prompt);
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
      const queue = new StreamEventQueue();
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

      if (protocolError) {
        yield { type: "error", error: protocolError };
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
    // A session parked awaiting Qoder's continuation is intentionally NOT torn
    // down here: the HTTP layer closes the reply socket after the tool_calls
    // response, which is indistinguishable from a cancel at this layer. Parked
    // sessions are bounded by AGY_SESSION_TTL_MS and released on resolution.
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
