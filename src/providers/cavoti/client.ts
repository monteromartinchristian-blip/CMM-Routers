import { RouterError, isUnsettledBillingState } from "../../core/errors.js";

export const CAVOTI_DEFAULT_BASE_URL = "https://cavoti.com/v1";
export const CAVOTI_DEFAULT_SECRET_ENV = "CAVOTI_API_KEY";
export const CAVOTI_PINNED_MODEL = "deepseek-v4.1-flash";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

export interface CavotiModelRecord {
  id: string;
}

export interface CavotiChatOptions {
  maxOutputTokens?: number | undefined;
  tools?: unknown[] | undefined;
  toolChoice?: unknown;
  parallelToolCalls?: boolean | undefined;
}

export interface CavotiClientLike {
  readSecret(): string;
  listModels(signal?: AbortSignal): Promise<CavotiModelRecord[]>;
  streamChatCompletion(
    model: string,
    messages: unknown[],
    signal?: AbortSignal,
    options?: CavotiChatOptions,
  ): AsyncIterable<Record<string, unknown>>;
}

export interface CavotiClientOptions {
  baseUrl?: string | undefined;
  secretEnv?: string | undefined;
  timeoutMs?: number | undefined;
  secret?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapStatus(status: number, body: string): RouterError {
  const lowered = body.toLowerCase();
  if (status === 401 || status === 403) {
    return new RouterError("provider_auth_required", "Cavoti authentication rejected");
  }
  // Account-state block first: an unsettled account is not an exhausted
  // allowance, and the operator action (settle the balance) is different.
  if (status === 402 && isUnsettledBillingState(body)) {
    return new RouterError(
      "provider_billing_blocked",
      "Cavoti account billing is blocked: unsettled usage must be settled before retrying",
      { billingState: "unsettled", upstream: body.slice(0, 300) },
    );
  }
  if (
    status === 402 ||
    lowered.includes("insufficient") ||
    lowered.includes("quota") ||
    lowered.includes("balance")
  ) {
    return new RouterError("provider_quota_exhausted", "Cavoti quota or balance exhausted");
  }
  if (status === 429) {
    return new RouterError("provider_rate_limited", "Cavoti rate limit reached");
  }
  if (status === 404) {
    return new RouterError("unknown_model", "Cavoti model or endpoint was not found");
  }
  return new RouterError(
    "provider_protocol_error",
    `Cavoti upstream returned HTTP ${status}`,
  );
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  return Buffer.byteLength(text, "utf8") <= MAX_ERROR_BODY_BYTES
    ? text
    : text.slice(0, MAX_ERROR_BODY_BYTES);
}

function parseSseFrame(frame: string): Record<string, unknown> | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("SSE payload is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RouterError(
      "provider_protocol_error",
      "Cavoti returned malformed SSE JSON",
    );
  }
}

async function* parseSseBody(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw new RouterError(
      "provider_protocol_error",
      "Cavoti streaming response has no body",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = function* (final = false): Generator<Record<string, unknown>> {
    buffer = buffer.replace(/\r\n/g, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseFrame(frame);
      if (parsed) yield parsed;
    }
    if (final && buffer.trim()) {
      const parsed = parseSseFrame(buffer);
      buffer = "";
      if (parsed) yield parsed;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
        throw new RouterError(
          "provider_protocol_error",
          "Cavoti SSE frame exceeded the bounded parser buffer",
        );
      }
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader is already settled.
    }
  }
}

export class CavotiClient implements CavotiClientLike {
  readonly baseUrl: string;
  readonly secretEnv: string;
  readonly timeoutMs: number;
  private readonly secretOverride: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: CavotiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? CAVOTI_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.secretEnv = options.secretEnv ?? CAVOTI_DEFAULT_SECRET_ENV;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.secretOverride = options.secret;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  readSecret(): string {
    const value = this.secretOverride ?? process.env[this.secretEnv];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RouterError(
        "provider_auth_required",
        `Cavoti secret environment variable ${this.secretEnv} is absent`,
      );
    }
    return value.trim();
  }

  async listModels(signal?: AbortSignal): Promise<CavotiModelRecord[]> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchFn(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.readSecret()}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw mapStatus(response.status, await readBoundedText(response));
      }

      const raw = await response.json() as unknown;
      const rows: unknown[] | null =
        Array.isArray(raw)
          ? raw
          : typeof raw === "object" &&
              raw !== null &&
              "data" in raw &&
              Array.isArray((raw as { data?: unknown }).data)
            ? (raw as { data: unknown[] }).data
            : null;
      if (!rows) {
        throw new RouterError(
          "provider_protocol_error",
          "Cavoti /models response has no model array",
        );
      }

      return rows
        .filter(
          (row: unknown): row is { id: string } =>
            typeof row === "object" &&
            row !== null &&
            typeof (row as { id?: unknown }).id === "string",
        )
        .map((row) => ({ id: row.id }));
    } catch (error) {
      if (timedOut && !signal?.aborted) {
        throw new RouterError("provider_timeout", "Cavoti request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async *streamChatCompletion(
    model: string,
    messages: unknown[],
    signal?: AbortSignal,
    options: CavotiChatOptions = {},
  ): AsyncGenerator<Record<string, unknown>> {
    if (model !== CAVOTI_PINNED_MODEL) {
      throw new RouterError(
        "unknown_model",
        `Cavoti route is pinned to ${CAVOTI_PINNED_MODEL}`,
      );
    }

    const body: Record<string, unknown> = {
      model: CAVOTI_PINNED_MODEL,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
    if (options.tools !== undefined) body.tools = options.tools;
    if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    if (options.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = options.parallelToolCalls;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.readSecret()}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw mapStatus(response.status, await readBoundedText(response));
      }

      for await (const record of parseSseBody(response)) {
        yield record;
      }
    } catch (error) {
      if (timedOut && !signal?.aborted) {
        throw new RouterError("provider_timeout", "Cavoti request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function cavotiUsageNumber(value: unknown): number | undefined {
  return finiteNumber(value);
}
