import { RouterError } from "../../core/errors.js";
import { assertNoSpendPath } from "./spend-guard.js";

export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_SECRET_ENV = "COMMAND_CODE_SECRET";
export const DEFAULT_TIMEOUT_MS = 120_000;

export const OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions";
export const ANTHROPIC_MESSAGES_PATH = "/messages";

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;
export const MAX_ANTHROPIC_MAX_TOKENS = 4096;

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
) => Promise<{
  status: number;
  text: () => Promise<string>;
  body?: unknown;
}>;

async function readBodyText(response: {
  status: number;
  text: () => Promise<string>;
  body?: unknown;
}): Promise<string> {
  return await response.text();
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const requestInit: RequestInit = {
            method: init.method,
            headers: init.headers,
            signal: init.signal ?? controller.signal,
          };
          if (init.body !== undefined) requestInit.body = init.body;
          const response = await fetch(url, requestInit);
          const text = await response.text();
          return { status: response.status, text: async () => text };
        } finally {
          clearTimeout(timer);
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
    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: buildAuthHeaders(secret),
        signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new RouterError("provider_timeout", "Command Code request timed out");
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    const bodyText = await readBodyText(response);
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
    options: { maxOutputTokens?: number | undefined; tools?: unknown[] | undefined } = {},
  ): AsyncGenerator<string, void> {
    yield* this.streamPath(
      OPENAI_CHAT_COMPLETIONS_PATH,
      "POST /chat/completions",
      model,
      messages,
      signal,
      options.tools !== undefined || options.maxOutputTokens !== undefined
        ? {
            ...(options.maxOutputTokens !== undefined
              ? { max_tokens: options.maxOutputTokens }
              : {}),
            ...(options.tools !== undefined ? { tools: options.tools } : {}),
          }
        : undefined,
    );
  }

  async *streamAnthropicMessages(
    model: string,
    messages: CommandCodeChatMessage[],
    signal: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncGenerator<string, void> {
    const secret = this.readSecret();
    assertNoSpendPath(model);
    const url = this.buildUrl(ANTHROPIC_MESSAGES_PATH);
    const body = buildAnthropicRequestBody(model, messages, maxOutputTokens);
    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: buildAuthHeaders(secret),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal.aborted) {
        return;
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    const bodyText = await readBodyText(response);
    if (response.status !== 200) {
      throw mapStatusToRouterError(response.status, bodyText, "POST /messages");
    }
    for (const chunk of splitSseChunks(bodyText)) {
      if (signal.aborted) return;
      yield chunk;
    }
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
    let response: { status: number; text: () => Promise<string> };
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: buildAuthHeaders(secret),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal.aborted) {
        return;
      }
      throw new RouterError(
        "provider_unavailable",
        `Command Code unreachable: ${(error as Error).message}`,
      );
    }
    const bodyText = await readBodyText(response);
    if (response.status !== 200) {
      throw mapStatusToRouterError(response.status, bodyText, context);
    }
    for (const chunk of splitSseChunks(bodyText)) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
}

export interface CommandCodeAnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicStreamState {
  textDeltas: string[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  completed: boolean;
  stopReason: string | undefined;
  error: string | undefined;
}

export function buildAnthropicRequestBody(
  model: string,
  messages: CommandCodeChatMessage[],
  maxOutputTokens?: number,
): Record<string, unknown> {
  const converted: CommandCodeAnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object") {
                  const record = part as Record<string, unknown>;
                  if (record.type === "text" && typeof record.text === "string") {
                    return record.text;
                  }
                }
                return "";
              })
              .join("")
          : "";
    converted.push({ role: message.role, content });
  }
  if (converted.length === 0) {
    throw new RouterError("invalid_request", "Anthropic request needs at least one message");
  }
  const requested = maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const bounded = Math.max(1, Math.min(MAX_ANTHROPIC_MAX_TOKENS, Math.floor(requested)));
  return {
    model,
    max_tokens: bounded,
    messages: converted,
    stream: true,
  };
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
