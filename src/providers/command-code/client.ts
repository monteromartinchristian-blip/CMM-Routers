import { RouterError } from "../../core/errors.js";
import { assertNoSpendPath } from "./spend-guard.js";

export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_SECRET_ENV = "COMMAND_CODE_SECRET";
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface CommandCodeModel {
  id: string;
  displayName?: string | undefined;
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
  if (status === 429 || lowered.includes("rate limit") || lowered.includes("rolling-window")) {
    return new RouterError("provider_rate_limited", `Command Code rate limited: ${context}`);
  }
  if (status === 404 || lowered.includes("not found") || lowered.includes("unknown model")) {
    return new RouterError("unknown_model", `Unknown Command Code model: ${context}`);
  }
  return new RouterError(
    "provider_protocol_error",
    `Command Code failure (${context}): ${bodyText.slice(0, 300)}`,
  );
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
        models.push({
          id,
          displayName: typeof record.display_name === "string" ? record.display_name : undefined,
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
    const secret = this.readSecret();
    assertNoSpendPath(model);
    const url = this.buildUrl("/chat/completions");
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (options.maxOutputTokens !== undefined) {
      body.max_tokens = options.maxOutputTokens;
    }
    if (options.tools !== undefined) {
      body.tools = options.tools;
    }
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
      throw mapStatusToRouterError(response.status, bodyText, "POST /chat/completions");
    }
    for (const chunk of splitSseChunks(bodyText)) {
      if (signal.aborted) return;
      yield chunk;
    }
  }
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
