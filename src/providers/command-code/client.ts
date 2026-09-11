import { RouterError } from "../../core/errors.js";
import { toAnthropicToolChoice } from "../../core/tool-policy.js";
import { assertNoSpendPath } from "./spend-guard.js";

export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_SECRET_ENV = "COMMAND_CODE_SECRET";
export const DEFAULT_TIMEOUT_MS = 120_000;

export const OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions";
export const ANTHROPIC_MESSAGES_PATH = "/messages";

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;
export const MAX_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * Maximum size of one unterminated upstream SSE frame. A provider that streams
 * a delimited frame without ever terminating it must not grow Router memory
 * without bound; overflow fails the request closed with a protocol error.
 */
export const MAX_PROVIDER_SSE_FRAME_BYTES = 1024 * 1024;

export type CommandCodeWire = "openai-chat-completions" | "anthropic-messages";

export interface CommandCodeModel {
  id: string;
  displayName?: string | undefined;
  wire: CommandCodeWire;
  family?: string | undefined;
  goatIncluded: boolean | null;
}

export interface CommandCodeChatMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export function buildAuthHeaders(secret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

export function safeLogContext(
  method: string,
  path: string,
  headers: Record<string, string>,
): { method: string; path: string; headers: Record<string, string> } {
  return { method, path, headers: redactHeaders(headers) };
}

export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
  },
) => Promise<CommandCodeHttpResponse>;

export interface CommandCodeHttpResponse {
  status: number;
  text: () => Promise<string>;
  body?: unknown;
  streamChunks?: () => AsyncIterable<string>;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<symbol, unknown>)
  );
}

function bodyToAsyncChunks(body: unknown): AsyncIterable<Uint8Array | string> | null {
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return (async function* () {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value as Uint8Array;
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  if (isAsyncIterable(body)) {
    return body as AsyncIterable<Uint8Array | string>;
  }
  return null;
}

function decodeChunk(
  decoder: TextDecoder | null,
  chunk: Uint8Array | string,
): string {
  if (typeof chunk === "string") return chunk;
  if (decoder) return decoder.decode(chunk, { stream: true });
  return Buffer.from(chunk).toString("utf-8");
}

function newStreamDecoder(): TextDecoder | null {
  return typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
}

async function readBodyText(response: {
  status: number;
  text: () => Promise<string>;
  body?: unknown;
}): Promise<string> {
  return await response.text();
}

/**
 * Bounded text-body reader for discovery and non-2xx error bodies. Races
 * body consumption against the remaining deadline budget and the caller
 * signal so headers-immediate/body-stalled responses terminate with
 * provider_timeout instead of hanging. Caller abort yields null (caller
 * exits silently); deadline expiry throws provider_timeout.
 */
async function readBodyTextBounded(
  response: { status: number; text: () => Promise<string>; body?: unknown },
  composed: { startedAt: number; timeoutMs: number },
  caller: AbortSignal | undefined,
): Promise<string | null> {
  const remaining = Math.max(0, composed.startedAt + composed.timeoutMs - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutEdge = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RouterError("provider_timeout", "Command Code request timed out"));
      }, remaining);
    });
    if (!caller) {
      return await Promise.race([response.text(), timeoutEdge]);
    }
    if (caller.aborted) return null;
    const callerEdge = new Promise<null>((resolve) => {
      caller.addEventListener("abort", () => resolve(null), { once: true });
    });
    return await Promise.race([response.text(), timeoutEdge, callerEdge]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function mapStatusToRouterError(
  status: number,
  bodyText: string,
  context: string,
): RouterError {
  const lowered = bodyText.toLowerCase();
  if (status === 401 || lowered.includes("invalid secret") || lowered.includes("unauthorized")) {
    return new RouterError("provider_auth_required", `Command Code auth required: ${context}`);
  }
  if (
    lowered.includes("insufficient credit") ||
    lowered.includes("quota exhausted") ||
    lowered.includes("plan quota") ||
    lowered.includes("goat") && lowered.includes("exhaust")
  ) {
    return new RouterError("provider_quota_exhausted", `Command Code plan quota exhausted: ${context}`);
  }
  if (
    lowered.includes("model_not_in_plan") ||
    lowered.includes("model not in plan") ||
    lowered.includes("not in your plan") ||
    lowered.includes("not included in") && lowered.includes("plan") ||
    lowered.includes("available in pro and above") ||
    lowered.includes("extra on demand") ||
    lowered.includes("extra on-demand") ||
    lowered.includes("on-demand usage")
  ) {
    // Plan-entitlement exclusion. The agreed stable contract has no dedicated
    // model-entitlement category; provider_quota_exhausted is the closest
    // fail-closed fit (like a zero-balance plan window): it never retries,
    // never falls back, and never spends. The full upstream message is kept
    // in meta for safe diagnostics.
    return new RouterError(
      "provider_quota_exhausted",
      `Command Code model excluded from GOAT plan (no on-demand fallback): ${context}`,
      { upstream: bodyText.slice(0, 300) },
    );
  }
  if (status === 429 || lowered.includes("rate limit") || lowered.includes("rolling-window")) {
    return new RouterError("provider_rate_limited", `Command Code rate limited: ${context}`);
  }
  if (
    status === 404 ||
    lowered.includes("not found") ||
    lowered.includes("unknown model") ||
    lowered.includes("must be called via")
  ) {
    return new RouterError("unknown_model", `Unknown Command Code model: ${context}`);
  }
  if (
    status === 400 && (
      lowered.includes("wrong") && lowered.includes("endpoint") ||
      lowered.includes("unsupported_model") ||
      lowered.includes("unsupported model")
    )
  ) {
    return new RouterError(
      "provider_protocol_error",
      `Command Code wire mismatch (${context}): ${bodyText.slice(0, 300)}`,
    );
  }
  return new RouterError(
    "provider_protocol_error",
    `Command Code failure (${context}): ${bodyText.slice(0, 300)}`,
  );
}

const KNOWN_WIRE_FIELDS = [
  "provider",
  "vendor",
  "owner",
  "api",
  "wire",
  "api_type",
  "apiType",
  "endpoint",
  "family",
  "model_family",
  "modelFamily",
] as const;

function readWireHint(record: Record<string, unknown>): CommandCodeWire | null {
  for (const field of KNOWN_WIRE_FIELDS) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const lowered = value.toLowerCase();
    if (
      lowered.includes("anthropic") ||
      lowered.includes("messages") && !lowered.includes("chat")
    ) {
      return "anthropic-messages";
    }
    if (
      lowered.includes("openai") ||
      lowered.includes("chat.completions") ||
      lowered.includes("chat_completions")
    ) {
      return "openai-chat-completions";
    }
  }
  return null;
}

function readFamily(record: Record<string, unknown>): string | undefined {
  for (const field of ["family", "model_family", "modelFamily", "provider", "vendor", "owner"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// GET /provider/v1/models is a GLOBAL Provider API catalog: it lists every
// model the API can serve, NOT the subset included in the user's GOAT plan.
// These fields would be authoritative plan-entitlement metadata if present.
const ENTITLEMENT_FIELDS = [
  "goat_included",
  "goatIncluded",
  "included_in_goat",
  "includedInGoat",
  "in_goat_plan",
  "inGoatPlan",
  "plan_access",
  "planAccess",
  "included_plans",
  "includedPlans",
  "plans",
  "tiers",
  "tier",
  "availability",
  "requires_extra_credits",
  "requiresExtraCredits",
  "extra_credits_required",
  "on_demand_only",
  "onDemandOnly",
] as const;

/**
 * Read authoritative GOAT plan-entitlement metadata from a live models-payload
 * entry. Returns true (GOAT-included), false (explicitly excluded), or null
 * when the payload carries no entitlement signal at all.
 *
 * Observed live evidence (2026-09-09): the endpoint returns bare catalog
 * entries with no entitlement fields, so every entry yields null.
 */
export function readGoatEntitlement(
  record: Record<string, unknown>,
): boolean | null {
  for (const field of ENTITLEMENT_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") {
      if (/requires_extra|on_demand_only|extra_credits/i.test(field)) {
        return !value;
      }
      return value;
    }
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      if (lowered === "goat" || lowered.includes("goat")) return true;
      if (lowered.includes("pro") && !lowered.includes("goat")) return false;
      if (lowered.includes("extra") || lowered.includes("on-demand") || lowered.includes("on_demand")) {
        return false;
      }
      continue;
    }
    if (Array.isArray(value)) {
      const lowered = value.map((v) => String(v).toLowerCase());
      if (lowered.some((v) => v === "goat" || v.includes("goat"))) return true;
      return false;
    }
  }
  return null;
}

/**
 * Narrow official Command Code routing rule, derived from the documented
 * model families (NOT a static catalog of individual model IDs):
 *
 *   Command Code Claude/Anthropic model IDs → anthropic-messages
 *   all other Command Code Provider API models → openai-chat-completions
 *
 * Individual model IDs are always discovered dynamically; only the family
 * convention is classified here.
 */
export function classifyCommandCodeWire(
  modelId: string,
  metadata: Record<string, unknown> = {},
): { wire: CommandCodeWire; family: string | undefined } {
  const hinted = readWireHint(metadata);
  const family = readFamily(metadata);
  if (hinted) return { wire: hinted, family };
  const lowered = modelId.toLowerCase();
  if (
    lowered.includes("claude") ||
    lowered.includes("anthropic") ||
    /(^|[^a-z])sonnet([^a-z]|$)/.test(lowered) ||
    /(^|[^a-z])opus([^a-z]|$)/.test(lowered) ||
    /(^|[^a-z])haiku([^a-z]|$)/.test(lowered)
  ) {
    return { wire: "anthropic-messages", family: family ?? "anthropic" };
  }
  return { wire: "openai-chat-completions", family };
}

export interface CommandCodeClientOptions {
  baseUrl?: string | undefined;
  secretEnv?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: FetchFn | undefined;
  secret?: string | undefined;
}

/**
 * Compose the caller signal with the client timeout for the fetch-headers
 * phase. Either side aborts the effective signal. The body phase needs its
 * own watchdog (armWatchdog): fetch resolving at headers must NOT clear
 * the overall deadline, so a fresh timer is armed when body iteration
 * starts and cleaned up when it settles.
 */
function composeTimeoutSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  startedAt: number;
  timeoutMs: number;
  armWatchdog: () => void;
} {
  const startedAt = Date.now();
  const noop = (): void => undefined;
  if (caller?.aborted) {
    return { signal: caller, cleanup: noop, startedAt, timeoutMs, armWatchdog: noop };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const onCallerAbort = (): void => {
    clear();
    controller.abort();
  };
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clear();
      caller?.removeEventListener("abort", onCallerAbort);
    },
    startedAt,
    timeoutMs,
    armWatchdog: () => {
      // Fresh watchdog for the body phase, budgeted on REMAINING time so
      // the full request (headers + body) cannot exceed timeoutMs.
      clear();
      const remaining = Math.max(0, startedAt + timeoutMs - Date.now());
      timer = setTimeout(() => controller.abort(), remaining);
    },
  };
}

export class CommandCodeClient {
  readonly baseUrl: string;
  readonly secretEnv: string;
  readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly secretOverride: string | undefined;

  constructor(options: CommandCodeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.secretEnv = options.secretEnv ?? DEFAULT_SECRET_ENV;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn =
      options.fetchFn ??
      (async (url, init) => {
        // The caller passes the already-composed OPERATION signal (deadline
        // + caller abort fused by composeTimeoutSignal at the call site).
        // It stays attached for the ENTIRE body lifecycle: cleanup happens
        // only when this wrapper's consumer finishes, never at headers.
        // No second composition here — double-compose + early cleanup is
        // what used to detach the native body reader after headers.
        try {
          const requestInit: RequestInit = {
            method: init.method,
            headers: init.headers,
            ...(init.signal ? { signal: init.signal } : {}),
          };
          if (init.body !== undefined) requestInit.body = init.body;
          const response = await fetch(url, requestInit);
          const chunks = bodyToAsyncChunks(response.body);
          const operationSignal = init.signal;
          const cancelNativeBody = (): void => {
            try {
              const reader = (chunks as unknown as { cancel?: unknown })
                ?.cancel;
              if (typeof reader === "function") {
                void (reader as () => Promise<unknown>).call(chunks).catch(() => undefined);
              }
            } catch {
              // Native teardown is best-effort.
            }
            try {
              const body = (response as unknown as { body?: { cancel?: unknown } })
                ?.body;
              if (body && typeof body.cancel === "function") {
                void (body.cancel as () => Promise<unknown>)().catch(() => undefined);
              }
            } catch {
              // Native teardown is best-effort.
            }
          };
          if (operationSignal?.aborted) cancelNativeBody();
          else operationSignal?.addEventListener("abort", cancelNativeBody, { once: true });
          return {
            status: response.status,
            text: async () => await response.clone().text(),
            ...(chunks
              ? {
                  streamChunks: async function* () {
                    // Per-response decoder: streaming TextDecoder state must
                    // never be shared across concurrent responses.
                    const decoder = newStreamDecoder();
                    let carry = "";
                    try {
                      for await (const raw of chunks) {
                        if (operationSignal?.aborted) return;
                        carry += decodeChunk(decoder, raw);
                        // Split complete SSE frames; keep partial tail buffered.
                        const frames = carry.split("\n\n");
                        carry = frames.pop() ?? "";
                        if (carry.length > MAX_PROVIDER_SSE_FRAME_BYTES) {
                          throw new RouterError(
                            "provider_protocol_error",
                            "Command Code upstream SSE frame exceeded the maximum buffered size",
                          );
                        }
                        for (const frame of frames) {
                          yield frame;
                        }
                      }
                      if (carry.trim()) yield carry;
                    } finally {
                      operationSignal?.removeEventListener("abort", cancelNativeBody);
                    }
                  },
                }
              : {}),
          };
        } finally {
          // NOTE: no composed.cleanup() here — the operation signal belongs
          // to the caller and outlives headers by design.
        }
      });
    this.secretOverride = options.secret;
  }

  wireForUpstreamId(modelId: string): CommandCodeWire {
    return classifyCommandCodeWire(modelId).wire;
  }

  readSecret(): string {
    if (this.secretOverride !== undefined) {
      if (!this.secretOverride) {
        throw new RouterError("provider_auth_required", "Command Code secret is empty");
      }
      return this.secretOverride;
    }
    const value = process.env[this.secretEnv];
    if (!value) {
      throw new RouterError(
        "provider_auth_required",
        `Command Code secret missing: set ${this.secretEnv}`,
      );
    }
    return value;
  }

  private buildUrl(path: string): string {
    assertNoSpendPath(path);
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  async listModels(signal?: AbortSignal): Promise<CommandCodeModel[]> {
    const secret = this.readSecret();
    const url = this.buildUrl("/models");
    const composed = composeTimeoutSignal(signal, this.timeoutMs);
    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: buildAuthHeaders(secret),
        signal: composed.signal,
      });
    } catch (error) {
      composed.cleanup();
      if (signal?.aborted) {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      if ((error as Error).name === "AbortError") {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    // The deadline stays armed through body consumption: a headers-
    // immediate/body-stalled /models response terminates with
    // provider_timeout instead of hanging discovery/health/startup.
    let bodyText: string | null;
    try {
      bodyText = await readBodyTextBounded(response, composed, signal);
    } catch (error) {
      composed.cleanup();
      throw error;
    }
    composed.cleanup();
    if (bodyText === null) {
      throw new RouterError("provider_timeout", "Command Code request timed out");
    }
    if (response.status !== 200) {
      throw mapStatusToRouterError(response.status, bodyText, "GET /models");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      throw new RouterError("provider_protocol_error", "Command Code models response malformed");
    }
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new RouterError("provider_protocol_error", "Command Code models response malformed");
    }
    const models: CommandCodeModel[] = [];
    for (const entry of data) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : null;
        if (!id) continue;
        const { wire, family } = classifyCommandCodeWire(id, record);
        models.push({
          id,
          displayName: typeof record.display_name === "string" ? record.display_name : undefined,
          wire,
          ...(family !== undefined ? { family } : {}),
          goatIncluded: readGoatEntitlement(record),
        });
      }
    }
    return models;
  }

  async *streamChatCompletion(
    model: string,
    messages: CommandCodeChatMessage[],
    signal: AbortSignal,
    options: {
      maxOutputTokens?: number | undefined;
      tools?: unknown[] | undefined;
      toolChoice?: unknown;
      parallelToolCalls?: boolean | undefined;
    } = {},
  ): AsyncGenerator<string, void> {
    const extra: Record<string, unknown> = {};
    if (options.maxOutputTokens !== undefined) extra.max_tokens = options.maxOutputTokens;
    if (options.tools !== undefined) extra.tools = options.tools;
    // Provider control semantics must reach the wire, never be silently dropped.
    if (options.toolChoice !== undefined) extra.tool_choice = options.toolChoice;
    if (options.parallelToolCalls !== undefined) {
      extra.parallel_tool_calls = options.parallelToolCalls;
    }
    yield* this.streamPath(
      OPENAI_CHAT_COMPLETIONS_PATH,
      "POST /chat/completions",
      model,
      messages,
      signal,
      Object.keys(extra).length > 0 ? extra : undefined,
    );
  }

  async *streamAnthropicMessages(
    model: string,
    messages: CommandCodeChatMessage[],
    signal: AbortSignal,
    maxOutputTokens?: number,
    tools?: unknown[],
    toolChoice?: unknown,
    parallelToolCalls?: boolean,
  ): AsyncGenerator<string, void> {
    const secret = this.readSecret();
    assertNoSpendPath(model);
    const url = this.buildUrl(ANTHROPIC_MESSAGES_PATH);
    const body = buildAnthropicRequestBody(
      model,
      messages,
      maxOutputTokens,
      tools,
      toolChoice,
      parallelToolCalls,
    );
    const composed = composeTimeoutSignal(signal, this.timeoutMs);
    let response: CommandCodeHttpResponse;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: buildAuthHeaders(secret),
        body: JSON.stringify(body),
        signal: composed.signal,
      });
    } catch (error) {
      composed.cleanup();
      if (signal.aborted) return;
      if ((error as Error).name === "AbortError") {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    // Status must be known BEFORE consuming the stream: buffer only the
    // status line decision, then yield frames incrementally as they arrive.
    // The composed deadline stays armed through body iteration (cleanup in
    // iterateWithDeadline), so headers resolving must NOT clear the timer.
    // The LIVE generator listens on the composed signal: when the deadline
    // fires mid-frame, the hung body is torn down instead of hanging.
    const { status, chunks } = await openStreamOrError(response, composed.signal ?? signal, "POST /messages");
    if (status !== 200) {
      // Non-200 bodies are small error payloads but can still stall: bound
      // the read by the remaining deadline instead of awaiting forever.
      let bodyText: string | null;
      try {
        bodyText = await readBodyTextBounded(response, composed, signal);
      } catch (error) {
        composed.cleanup();
        throw error;
      }
      composed.cleanup();
      if (bodyText === null) {
        if (signal.aborted) return;
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw mapStatusToRouterError(response.status, bodyText, "POST /messages");
    }
    yield* iterateWithDeadline(chunks, composed, signal);
  }

  private async *streamPath(
    path: string,
    context: string,
    model: string,
    messages: CommandCodeChatMessage[],
    signal: AbortSignal,
    extraBody?: Record<string, unknown>,
  ): AsyncGenerator<string, void> {
    const secret = this.readSecret();
    assertNoSpendPath(model);
    const url = this.buildUrl(path);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(extraBody ?? {}),
    };
    const composed = composeTimeoutSignal(signal, this.timeoutMs);
    let response: CommandCodeHttpResponse;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: buildAuthHeaders(secret),
        body: JSON.stringify(body),
        signal: composed.signal,
      });
    } catch (error) {
      composed.cleanup();
      if (signal.aborted) return;
      if ((error as Error).name === "AbortError") {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    const { status, chunks } = await openStreamOrError(response, composed.signal ?? signal, context);
    if (status !== 200) {
      let bodyText: string | null;
      try {
        bodyText = await readBodyTextBounded(response, composed, signal);
      } catch (error) {
        composed.cleanup();
        throw error;
      }
      composed.cleanup();
      if (bodyText === null) {
        if (signal.aborted) return;
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw mapStatusToRouterError(response.status, bodyText, context);
    }
    yield* iterateWithDeadline(chunks, composed, signal);
  }
}

/**
 * Iterate body frames while the composed deadline stays armed. A watchdog
 * timer fires at the remaining budget and aborts the deadline signal; the
 * abort-aware live() generator then tears down the hung body and the loop
 * below observes the abort and raises provider_timeout. Caller abort
 * returns silently. Cleanup runs only after terminal consumption.
 */
async function* iterateWithDeadline(
  chunks: AsyncGenerator<string, void>,
  composed: {
    signal: AbortSignal | undefined;
    cleanup: () => void;
    startedAt: number;
    timeoutMs: number;
    armWatchdog: () => void;
  },
  caller: AbortSignal | undefined,
): AsyncGenerator<string, void> {
  const deadline = composed.signal;
  try {
    if (!deadline) {
      yield* chunks;
      return;
    }
    if (deadline.aborted) {
      if (caller?.aborted) return;
      throw new RouterError("provider_timeout", "Command Code request timed out");
    }
    // Arm the watchdog now: the composed timer was NOT started for the
    // body phase (composition only guards fetch headers). The watchdog
    // aborts the deadline at the remaining budget.
    composed.armWatchdog();
    for await (const frame of chunks) {
      if (caller?.aborted) return;
      if (deadline.aborted) {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      yield frame;
    }
    if (deadline.aborted && !caller?.aborted) {
      throw new RouterError("provider_timeout", "Command Code request timed out");
    }
  } finally {
    composed.cleanup();
  }
}

/**
 * Decide the HTTP status before streaming frames. Shared by both wires.
 * Returns a frame iterator the caller must consume through
 * iterateWithDeadline so the deadline stays armed through the body.
 * For real fetch responses the status is available immediately while the
 * body streams; for test doubles without streamChunks, the buffered text
 * is split into frames.
 *
 * Every generator created here registers its pending-settle callbacks on
 * the passed signal: when the deadline fires mid-frame, the hung body is
 * torn down via generator.throw/return instead of hanging the consumer.
 */
async function openStreamOrError(
  response: CommandCodeHttpResponse,
  signal: AbortSignal,
  context: string,
): Promise<{ status: number; chunks: AsyncGenerator<string, void> }> {
  void context;
  async function* buffered(): AsyncGenerator<string, void> {
    const bodyText = await readBodyText(response);
    for (const chunk of splitSseChunks(bodyText)) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
  if (!response.streamChunks) {
    return { status: response.status, chunks: buffered() };
  }
  const source = response.streamChunks!;
  async function* live(): AsyncGenerator<string, void> {
    // Single abort-aware body loop: the watchdog below aborts the composed
    // signal at the remaining budget, which tears down a pending source
    // next() via tearDown and ends this loop. No nested generator boundary
    // can trap the abort between live() and its consumer.
    const iterator = source()[Symbol.asyncIterator]();
    let tornDown = false;
    const tearDown = (): void => {
      if (tornDown) return;
      tornDown = true;
      // Tear down synchronously where possible: generator.throw() into a
      // generator parked at await runs its finally blocks and settles the
      // pending next(). The returned promise is handled to avoid floating
      // rejections; settlement itself is synchronous for parked generators.
      try {
        const pending = iterator.throw?.(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        ) as Promise<unknown> | unknown;
        if (pending && typeof (pending as Promise<unknown>).catch === "function") {
          (pending as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // Teardown is best-effort.
      }
      try {
        const pending = iterator.return?.(undefined) as Promise<unknown> | unknown;
        if (pending && typeof (pending as Promise<unknown>).catch === "function") {
          (pending as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // Teardown is best-effort.
      }
    };
    if (signal.aborted) return;
    signal.addEventListener("abort", tearDown, { once: true });
    const abortEdge = (): Promise<{ kind: "aborted" }> =>
      new Promise<{ kind: "aborted" }>((resolve) => {
        if (signal.aborted) {
          resolve({ kind: "aborted" });
          return;
        }
        signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
          once: true,
        });
      });
    let sourceError: unknown;
    try {
      for (;;) {
        // Race the source frame against teardown: after tearDown runs, the
        // source next() may never settle on its own, so the abort edge
        // must win promptly instead of awaiting a hung body.
        const next = await Promise.race([
          iterator.next().then(
            (value) => ({ kind: "frame" as const, value }),
            (error: unknown) => {
              // A body error is NOT a clean end: record it so a fail-closed
              // source (e.g. an oversize-frame guard) is surfaced instead of
              // being mistaken for a completed stream.
              sourceError = error;
              return { kind: "closed" as const };
            },
          ),
          abortEdge(),
        ]);
        if (next.kind !== "frame") {
          if (sourceError !== undefined && !signal.aborted) {
            throw sourceError instanceof Error
              ? sourceError
              : new RouterError("provider_protocol_error", String(sourceError));
          }
          return;
        }
        if (signal.aborted) return;
        if (next.value.done) return;
        yield next.value.value;
      }
    } finally {
      signal.removeEventListener("abort", tearDown);
    }
  }
  return { status: response.status, chunks: live() };
}

export interface CommandCodeAnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface CommandCodeAnthropicMessage {
  role: "user" | "assistant";
  content: string | CommandCodeAnthropicContentBlock[];
}

export interface AnthropicStreamState {
  textDeltas: string[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  completed: boolean;
  stopReason: string | undefined;
  error: string | undefined;
}

function anthropicTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") return record.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Anthropic Messages uses a native structured tool protocol. A complete
 * assistant tool call must carry parseable JSON arguments; malformed complete
 * arguments fail closed here (before any upstream request) instead of being
 * forwarded as an opaque string.
 */
function anthropicToolInput(rawArguments: unknown): unknown {
  if (typeof rawArguments !== "string") {
    if (rawArguments === undefined || rawArguments === null) {
      throw new RouterError(
        "provider_protocol_error",
        "Anthropic tool call is missing arguments",
      );
    }
    return rawArguments;
  }
  const trimmed = rawArguments.trim();
  if (trimmed.length === 0) {
    throw new RouterError(
      "provider_protocol_error",
      "Anthropic tool call has empty arguments",
    );
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new RouterError(
      "provider_protocol_error",
      "Anthropic tool call arguments are malformed JSON",
    );
  }
}

export function buildAnthropicRequestBody(
  model: string,
  messages: CommandCodeChatMessage[],
  maxOutputTokens?: number,
  tools?: unknown[],
  toolChoice?: unknown,
  parallelToolCalls?: boolean,
): Record<string, unknown> {
  const converted: CommandCodeAnthropicMessage[] = [];
  const systemParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = anthropicTextOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      const toolUseId =
        typeof message.tool_call_id === "string" && message.tool_call_id.length > 0
          ? message.tool_call_id
          : undefined;
      if (toolUseId === undefined) {
        throw new RouterError(
          "provider_protocol_error",
          "Anthropic tool result requires a tool_use_id",
        );
      }
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: anthropicTextOf(message.content),
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: CommandCodeAnthropicContentBlock[] = [];
      const text = anthropicTextOf(message.content);
      if (text) blocks.push({ type: "text", text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const rawCall of calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const fn = call.function as Record<string, unknown> | undefined;
        const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
        const name =
          typeof fn?.name === "string" && fn.name.length > 0 ? fn.name : undefined;
        if (id === undefined || name === undefined) {
          throw new RouterError(
            "provider_protocol_error",
            "Anthropic assistant tool call requires id and name",
          );
        }
        blocks.push({
          type: "tool_use",
          id,
          name,
          input: anthropicToolInput(fn?.arguments),
        });
      }
      converted.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : anthropicTextOf(message.content),
      });
      continue;
    }
    if (message.role !== "user") continue;
    converted.push({ role: "user", content: anthropicTextOf(message.content) });
  }
  if (converted.length === 0) {
    throw new RouterError("invalid_request", "Anthropic request needs at least one message");
  }
  const requested = maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const bounded = Math.max(1, Math.min(MAX_ANTHROPIC_MAX_TOKENS, Math.floor(requested)));
  // Exact Anthropic Messages representation of the caller's tool policy. A
  // constraint the wire cannot express is rejected, never silently dropped.
  const anthropicToolChoice = toAnthropicToolChoice(toolChoice, parallelToolCalls);
  return {
    model,
    max_tokens: bounded,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
    messages: converted,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(anthropicToolChoice !== null ? { tool_choice: anthropicToolChoice } : {}),
  };
}

/**
 * Parse ONE Anthropic Messages SSE frame (a single data: payload, without
 * the "data:" prefix handling — use parseAnthropicEvent for that).
 * Throws provider_protocol_error on malformed JSON so callers fail closed.
 */
export function parseAnthropicEvent(data: string): {
  kind: "text" | "usage" | "stop" | "error" | "ignore" | "tool_use_start" | "tool_use_delta";
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  error?: string;
  toolUse?: { index: number; id: string; name: string };
  partialJson?: string;
} {
  let event: unknown;
  try {
    event = JSON.parse(data) as unknown;
  } catch {
    throw new RouterError(
      "provider_protocol_error",
      `Malformed Anthropic SSE payload: ${data.slice(0, 200)}`,
    );
  }
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const record = event as Record<string, unknown>;
  const type = record.type;
  if (type === "error") {
    const nested = record.error as Record<string, unknown> | undefined;
    const message =
      (typeof nested?.message === "string" ? nested.message : null) ??
      (typeof record.message === "string" ? record.message : null) ??
      "Anthropic upstream error";
    return { kind: "error", error: String(message).slice(0, 300) };
  }
  if (type === "content_block_start") {
    const block = record.content_block as Record<string, unknown> | undefined;
    const index = typeof record.index === "number" ? record.index : 0;
    if (
      block &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      return { kind: "tool_use_start", toolUse: { index, id: block.id, name: block.name } };
    }
    return { kind: "ignore" };
  }
  if (type === "content_block_delta") {
    const delta = record.delta as Record<string, unknown> | undefined;
    const index = typeof record.index === "number" ? record.index : 0;
    if (delta && typeof delta.text_delta === "string" && delta.text_delta.length > 0) {
      return { kind: "text", text: delta.text_delta };
    }
    if (delta && typeof delta.text === "string" && delta.text.length > 0) {
      return { kind: "text", text: delta.text };
    }
    // Streaming tool arguments: partial JSON fragments assembled by caller.
    if (delta && typeof delta.partial_json === "string") {
      return {
        kind: "tool_use_delta",
        toolUse: { index, id: "", name: "" },
        partialJson: delta.partial_json,
      };
    }
    return { kind: "ignore" };
  }
  if (type === "message_delta") {
    const delta = record.delta as Record<string, unknown> | undefined;
    const usage = record.usage as Record<string, unknown> | undefined;
    const out: { kind: "usage"; outputTokens?: number; stopReason?: string } = { kind: "usage" };
    let seen = false;
    if (delta && typeof delta.stop_reason === "string") {
      (out as { stopReason?: string }).stopReason = delta.stop_reason;
      seen = true;
    }
    if (usage && typeof usage === "object" && typeof usage.output_tokens === "number") {
      out.outputTokens = usage.output_tokens;
      seen = true;
    }
    return seen ? out : { kind: "ignore" };
  }
  if (type === "message_start") {
    const message = record.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const out: { kind: "usage"; inputTokens?: number; outputTokens?: number } = { kind: "usage" };
      let seen = false;
      if (typeof usage.input_tokens === "number") {
        out.inputTokens = usage.input_tokens;
        seen = true;
      }
      if (typeof usage.output_tokens === "number") {
        out.outputTokens = usage.output_tokens;
        seen = true;
      }
      if (seen) return out;
    }
    return { kind: "ignore" };
  }
  if (type === "message_stop") {
    return { kind: "stop" };
  }
  return { kind: "ignore" };
}

/**
 * Parse Anthropic Messages SSE stream events. Handles the standard event
 * vocabulary (message_start, content_block_start, content_block_delta,
 * message_delta, message_stop, error) split across arbitrary chunks.
 */
export function parseAnthropicStreamEvents(bodyText: string): AnthropicStreamState {
  const state: AnthropicStreamState = {
    textDeltas: [],
    inputTokens: undefined,
    outputTokens: undefined,
    completed: false,
    stopReason: undefined,
    error: undefined,
  };
  for (const chunk of splitSseChunks(bodyText)) {
    const data = parseSseDataLine(chunk);
    if (data === null) continue;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new RouterError(
        "provider_protocol_error",
        `Malformed Anthropic SSE payload: ${data.slice(0, 200)}`,
      );
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type === "error") {
      const nested = record.error as Record<string, unknown> | undefined;
      const message =
        (typeof nested?.message === "string" ? nested.message : null) ??
        (typeof record.message === "string" ? record.message : null) ??
        "Anthropic upstream error";
      state.error = String(message).slice(0, 300);
      return state;
    }
    if (type === "content_block_delta") {
      const delta = record.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.text_delta === "string" && delta.text_delta.length > 0) {
        state.textDeltas.push(delta.text_delta);
      } else if (delta && typeof delta.text === "string" && delta.text.length > 0) {
        state.textDeltas.push(delta.text);
      }
      continue;
    }
    if (type === "message_delta") {
      const delta = record.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        state.stopReason = delta.stop_reason;
      }
      const usage = record.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        if (typeof usage.output_tokens === "number") {
          state.outputTokens = usage.output_tokens;
        }
      }
      continue;
    }
    if (type === "message_start") {
      const message = record.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        if (typeof usage.input_tokens === "number") {
          state.inputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === "number") {
          state.outputTokens = usage.output_tokens;
        }
      }
      continue;
    }
    if (type === "message_stop") {
      state.completed = true;
      continue;
    }
  }
  return state;
}

export function splitSseChunks(bodyText: string): string[] {
  return bodyText
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseSseDataLine(chunk: string): string | null {
  const lines = chunk.split("\n").map((l) => l.trim());
  const dataLines = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length).trim());
  if (dataLines.length === 0) return null;
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") return null;
  return joined;
}
