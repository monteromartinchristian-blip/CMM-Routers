import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
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

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = "google" as const;
  private activeRequests = new Map<string, { abort: () => void; cwd: string }>();
  private runner: InferenceRunner;
  private modelsRunner: AgyRunner;
  private readonly agyPath: string;

  constructor(
    runner?: InferenceRunner,
    modelsRunner?: AgyRunner,
    options: { agyPath?: string | undefined } = {},
  ) {
    this.agyPath = options.agyPath ?? AGY_PATH;
    this.runner = runner ?? new SpawnInferenceRunner(this.agyPath);
    this.modelsRunner = modelsRunner ?? new RealAgyRunner(this.agyPath);
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
      capability: "CHAT_ONLY" as const,
    }));
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

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
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
    const cwd = mkdtempSync(join(tmpdir(), "cmm-antigravity-run-"));
    ensureNeutralCwd(cwd);
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

    const prompt = request.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content ?? "")
      .join("\n");
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

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.activeRequests.set(request.requestId, {
      abort: () => abortController.abort(),
      cwd,
    });

    try {
      // Incremental streaming: deltas yield as NDJSON lines arrive, before
      // the child exits. Completion is only emitted for an observed terminal
      // result event — never synthesized from process close.
      const pendingTexts: string[] = [];
      let terminalSeen = false;
      let terminalFinish: StreamParseResult["finishReason"] = "stop";
      let protocolError: RouterError | undefined;
      let usageYielded = false;

      const yieldUsage = function* (
        usage: NonNullable<StreamParseResult["usage"]>,
      ): Generator<RouterEvent> {
        if (usageYielded) return;
        usageYielded = true;
        yield {
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
        if (event.kind === "text" && event.texts) {
          for (const text of event.texts) {
            pendingTexts.push(text);
          }
        } else if (event.kind === "usage" && event.usage) {
          for (const yielded of yieldUsage(event.usage)) {
            pendingTexts.push(`\0usage:${JSON.stringify(yielded)}`);
          }
        } else if (event.kind === "completed") {
          terminalSeen = true;
          terminalFinish = event.finishReason ?? "stop";
        } else if (event.kind === "protocolError" && event.error && !protocolError) {
          protocolError = event.error;
        }
      };

      const flushTexts = function* (): Generator<RouterEvent> {
        while (pendingTexts.length > 0) {
          const next = pendingTexts.shift()!;
          if (next.startsWith("\0usage:")) {
            yield JSON.parse(next.slice("\0usage:".length)) as RouterEvent;
          } else {
            yield { type: "text_delta", text: next };
          }
        }
      };

      let result: AgyRunResult;
      try {
        result = await this.runner.streamInference(
          args,
          {
            cwd,
            timeoutMs: PRINT_TIMEOUT_MS,
            signal: abortController.signal,
          },
          onEvent,
        );
      } catch (error) {
        if (signal.aborted || abortController.signal.aborted) return;
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

      // Drain anything that arrived before close/error resolution.
      yield* flushTexts();

      if (signal.aborted || abortController.signal.aborted) {
        return;
      }

      if (protocolError) {
        yield { type: "error", error: protocolError };
        return;
      }

      if (result.error && /timed out/i.test(result.error.message)) {
        yield {
          type: "error",
          error: new RouterError("provider_timeout", "Antigravity print timed out"),
        };
        return;
      }
      if (result.error && /ENOENT/.test(result.error.message)) {
        yield {
          type: "error",
          error: new RouterError("provider_unavailable", "agy CLI not found"),
        };
        return;
      }
      if (result.status !== 0) {
        yield { type: "error", error: mapAgyFailureToRouterError(result, "agy --print") };
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
    }
  }

  async cancel(requestId: string): Promise<void> {
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
