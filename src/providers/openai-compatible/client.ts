import { RouterError, isUnsettledBillingState } from "../../core/errors.js";
import { splitSseChunks, parseSseDataLine } from "../../core/sse.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Error bodies are diagnostics, not data: keep them small and non-sensitive. */
export const MAX_ERROR_BODY_CHARS = 300;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

/**
 * Minimal HTTP shape the transport needs. A real `fetch` Response satisfies it
 * structurally, and tests inject plain objects or ReadableStream bodies.
 */
export interface ProviderHttpResponse {
  status: number;
  text: () => Promise<string>;
  body?: unknown;
}

export type ProviderFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
  },
) => Promise<ProviderHttpResponse>;

export interface OpenAiCompatibleClientOptions {
  /** Provider base URL, already validated as public https, no trailing slash. */
  baseUrl: string;
  /** Environment variable NAME holding the credential (never a value). */
  secretEnv: string;
  /** Injected credential for tests. Production reads `secretEnv` from env. */
  secret?: string | undefined;
  /** Display name used in error messages. Never contains a credential. */
  providerLabel: string;
  timeoutMs?: number | undefined;
  fetchFn?: ProviderFetchFn | undefined;
}

interface Deadline {
  dispose: () => void;
  timedOut: () => boolean;
  signal: AbortSignal;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<symbol, unknown>)
  );
}

function isReadableStreamBody(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function abortedError(): Error {
  return Object.assign(new Error("caller aborted"), { name: "AbortError" });
}

/**
 * Normalized upstream error categories for the OpenAI-compatible wave. The
 * mapping is deliberately conservative: an unrecognized failure is a protocol
 * error, never a silent success and never a retry signal.
 */
export function mapProviderStatus(
  status: number,
  bodyText: string,
  context: string,
): RouterError {
  const lowered = bodyText.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    lowered.includes("invalid api key") ||
    lowered.includes("invalid_api_key") ||
    lowered.includes("unauthorized") ||
    lowered.includes("authentication")
  ) {
    return new RouterError(
      "provider_auth_required",
      `Provider authentication rejected: ${context}`,
    );
  }
  if (status === 402 && isUnsettledBillingState(bodyText)) {
    // Same account-state vocabulary as the dedicated Cavoti route: an
    // unsettled account is a billing block, not an exhausted allowance.
    return new RouterError(
      "provider_billing_blocked",
      `Provider account billing is blocked: outstanding usage must be settled (${context})`,
      { billingState: "unsettled", upstream: bodyText.slice(0, MAX_ERROR_BODY_CHARS) },
    );
  }
  if (
    status === 402 ||
    lowered.includes("insufficient") ||
    lowered.includes("quota") ||
    lowered.includes("balance") ||
    lowered.includes("credit")
  ) {
    return new RouterError(
      "provider_quota_exhausted",
      `Provider quota or balance exhausted: ${context}`,
    );
  }
  if (status === 429 || lowered.includes("rate limit") || lowered.includes("too many requests")) {
    return new RouterError("provider_rate_limited", `Provider rate limited: ${context}`);
  }
  if (
    status === 404 ||
    (lowered.includes("model") &&
      (lowered.includes("not found") ||
        lowered.includes("does not exist") ||
        lowered.includes("unknown") ||
        lowered.includes("not_exist")))
  ) {
    return new RouterError("unknown_model", `Unknown provider model: ${context}`);
  }
  return new RouterError(
    "provider_protocol_error",
    `Provider failure (${context}): ${bodyText.slice(0, MAX_ERROR_BODY_CHARS)}`,
  );
}

/**
 * HTTP transport for every provider in the approved wave. It owns exactly two
 * provider-neutral concerns: authenticated requests to the manifest's
 * administrative metadata path, and streamed OpenAI chat completions. Provider
 * identity (id, base URL, credential namespace, discovery path, api style)
 * comes from the manifest or config; none of it is hardcoded here.
 */
export class OpenAiCompatibleClient {
  readonly baseUrl: string;
  readonly secretEnv: string;
  readonly providerLabel: string;
  readonly timeoutMs: number;
  private readonly secretOverride: string | undefined;
  private readonly fetchFn: ProviderFetchFn;

  constructor(options: OpenAiCompatibleClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secretEnv = options.secretEnv;
    this.providerLabel = options.providerLabel;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.secretOverride = options.secret;
    this.fetchFn = options.fetchFn ?? (fetch as unknown as ProviderFetchFn);
  }

  readSecret(): string {
    const value = this.secretOverride ?? process.env[this.secretEnv];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RouterError(
        "provider_auth_required",
        `${this.providerLabel} credential environment variable ${this.secretEnv} is absent`,
      );
    }
    return value.trim();
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.readSecret()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
  }

  buildUrl(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  /** One deadline per operation, armed for the whole request lifecycle. */
  private armDeadline(caller: AbortSignal | undefined): Deadline {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    if (caller?.aborted) controller.abort();
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        caller?.removeEventListener("abort", onCallerAbort);
      },
      timedOut: () => timedOut,
    };
  }

  /**
   * Send one request under the operation deadline. The fetch promise is raced
   * against the abort edge so a transport that ignores the signal (or a
   * never-settling double) can never hang the caller.
   */
  private async send(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string | undefined },
    deadline: Deadline,
    caller: AbortSignal | undefined,
    context: string,
  ): Promise<ProviderHttpResponse> {
    if (caller?.aborted) throw abortedError();
    if (deadline.signal.aborted) {
      throw new RouterError("provider_timeout", `${this.providerLabel} request timed out`);
    }
    const pending = this.fetchFn(this.buildUrl(path), {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: deadline.signal,
    });
    // A losing race must not surface as an unhandled rejection.
    pending.catch(() => undefined);
    const abortEdge = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(
          deadline.timedOut() && !caller?.aborted
            ? new RouterError("provider_timeout", `${this.providerLabel} request timed out`)
            : abortedError(),
        );
      };
      if (deadline.signal.aborted) onAbort();
      else deadline.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, abortEdge]);
    } catch (error) {
      throw this.normalizeError(error, caller, deadline, context);
    }
  }

  private normalizeError(
    error: unknown,
    caller: AbortSignal | undefined,
    deadline: Deadline,
    context: string,
  ): Error {
    if (error instanceof RouterError) return error;
    if (caller?.aborted) return abortedError();
    if (deadline.timedOut() || (error as Error)?.name === "AbortError") {
      return new RouterError("provider_timeout", `${this.providerLabel} request timed out`);
    }
    return new RouterError(
      "provider_unavailable",
      `${this.providerLabel} unreachable (${context}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  /**
   * Administrative model listing on the manifest's discovery path. GET only:
   * discovery must never touch a generation endpoint.
   */
  async listModels(discoveryPath: string, signal?: AbortSignal): Promise<unknown[]> {
    const deadline = this.armDeadline(signal);
    try {
      const response = await this.send(
        discoveryPath,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.readSecret()}`, Accept: "application/json" },
        },
        deadline,
        signal,
        `GET ${discoveryPath}`,
      );
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (error) {
        throw this.normalizeError(error, signal, deadline, `GET ${discoveryPath}`);
      }
      if (response.status !== 200) {
        throw mapProviderStatus(response.status, bodyText, `GET ${discoveryPath}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        throw new RouterError(
          "provider_protocol_error",
          `${this.providerLabel} model discovery response is not JSON`,
        );
      }
      const data =
        parsed !== null && typeof parsed === "object" && "data" in parsed
          ? (parsed as { data?: unknown }).data
          : undefined;
      if (!Array.isArray(data)) {
        throw new RouterError(
          "provider_protocol_error",
          `${this.providerLabel} model discovery response has no model array`,
        );
      }
      return data;
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Streamed chat completion. Yields one parsed SSE record per upstream frame;
   * event semantics live in the adapter so both sides stay provider-neutral.
   */
  async *streamChatCompletion(
    upstreamModel: string,
    messages: unknown[],
    signal: AbortSignal | undefined,
    options: {
      maxOutputTokens?: number | undefined;
      tools?: unknown[] | undefined;
      toolChoice?: unknown;
      parallelToolCalls?: boolean | undefined;
    } = {},
  ): AsyncGenerator<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages,
      stream: true,
    };
    if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
    if (options.tools !== undefined && options.tools.length > 0) body.tools = options.tools;
    if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    if (options.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = options.parallelToolCalls;
    }

    const path = "/chat/completions";
    const deadline = this.armDeadline(signal);
    try {
      const response = await this.send(
        path,
        { method: "POST", headers: this.authHeaders(), body: JSON.stringify(body) },
        deadline,
        signal,
        `POST ${path}`,
      );
      if (response.status !== 200) {
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch (error) {
          throw this.normalizeError(error, signal, deadline, `POST ${path}`);
        }
        throw mapProviderStatus(response.status, bodyText, `POST ${path}`);
      }
      for await (const record of readSseRecords(response, deadline.signal, signal)) {
        yield record;
      }
      if (deadline.timedOut() && !signal?.aborted) {
        throw new RouterError("provider_timeout", `${this.providerLabel} request timed out`);
      }
    } catch (error) {
      throw this.normalizeError(error, signal, deadline, `POST ${path}`);
    } finally {
      deadline.dispose();
    }
  }
}

/**
 * Parse an SSE response body into records, accepting both a live stream body
 * (real fetch) and a buffered text body (test doubles, non-streaming proxies).
 */
async function* readSseRecords(
  response: ProviderHttpResponse,
  transport: AbortSignal,
  caller: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body;
  if (isReadableStreamBody(body) || isAsyncIterable(body)) {
    yield* readFrames(streamFrames(body, transport, caller));
    return;
  }
  const bodyText = await response.text();
  yield* readFrames(splitSseChunks(bodyText));
}

async function* streamFrames(
  body: ReadableStream<Uint8Array> | AsyncIterable<unknown>,
  transport: AbortSignal,
  caller: AbortSignal | undefined,
): AsyncGenerator<string> {
  const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  let carry = "";
  const chunks: AsyncIterable<Uint8Array | string> = isReadableStreamBody(body)
    ? (async function* () {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // Reader is already settled.
          }
        }
      })()
    : (body as AsyncIterable<Uint8Array | string>);

  for await (const raw of chunks) {
    if (transport.aborted || caller?.aborted) return;
    carry +=
      typeof raw === "string"
        ? raw
        : decoder
          ? decoder.decode(raw, { stream: true })
          : Buffer.from(raw).toString("utf-8");
    if (Buffer.byteLength(carry, "utf8") > MAX_SSE_BUFFER_BYTES) {
      throw new RouterError(
        "provider_protocol_error",
        "Upstream SSE frame exceeded the bounded transport buffer",
      );
    }
    const frames = carry.split("\n\n");
    carry = frames.pop() ?? "";
    for (const frame of frames) yield frame;
  }
  if (carry.trim()) yield carry;
}

async function* readFrames(
  frames: Iterable<string> | AsyncIterable<string>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const frame of frames) {
    const data = parseSseDataLine(frame);
    if (data === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new RouterError(
        "provider_protocol_error",
        `Malformed upstream SSE payload: ${data.slice(0, 200)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    yield parsed as Record<string, unknown>;
  }
}
