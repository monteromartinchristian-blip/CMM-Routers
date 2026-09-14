import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { toChatWireToolChoice } from "../../core/tool-policy.js";
import {
  isActivatedModel,
  type ProviderManifest,
} from "../manifest.js";
import {
  OpenAiCompatibleClient,
  mapProviderStatus,
  type OpenAiCompatibleClientOptions,
  type ProviderFetchFn,
  type ProviderHttpResponse,
} from "./client.js";

export { OpenAiCompatibleClient, mapProviderStatus };
export type { OpenAiCompatibleClientOptions, ProviderFetchFn, ProviderHttpResponse };

export const OPENAI_CHAT_COMPLETIONS_STYLE = "openai-chat-completions" as const;

export interface OpenAiCompatibleAdapterOptions {
  manifest: ProviderManifest;
  /** Effective base URL (config override wins over the manifest default). */
  baseUrl?: string | undefined;
  /** Credential namespace override; defaults to the manifest's. */
  secretEnv?: string | undefined;
  /** Administrative discovery path override (config `discoveryPath`). */
  discoveryPath?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: ProviderFetchFn | undefined;
  client?: OpenAiCompatibleClient | undefined;
}

interface PendingCancellation {
  abort: () => void;
}

function toUpstreamMessages(request: RouterRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    const base: Record<string, unknown> = {
      role: message.role,
      content: message.content ?? "",
    };
    if (message.toolCallId !== undefined) base.tool_call_id = message.toolCallId;
    if (message.name !== undefined) base.name = message.name;
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
    }
    return base;
  });
}

function toUpstreamTools(request: RouterRequest): unknown[] {
  return request.tools.map((tool) => ({
    type: tool.type,
    function: {
      name: tool.function.name,
      ...(tool.function.description !== undefined
        ? { description: tool.function.description }
        : {}),
      parameters: tool.function.parameters,
    },
  }));
}

function finishReason(value: string): "stop" | "length" | "tool_calls" {
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool_calls";
  return "stop";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Generic OpenAI-compatible adapter: one class for every provider in the
 * approved wave, parameterized entirely by its manifest (identity, base URL,
 * credential namespace, discovery path, api styles, tool capability,
 * activation). A provider only earns its own adapter class when a demonstrated
 * protocol or account-state difference requires it; see the wave ledger.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: ProviderManifest["id"];
  private readonly manifest: ProviderManifest;
  private readonly client: OpenAiCompatibleClient;
  private readonly discoveryPath: string;
  private readonly pending = new Map<string, PendingCancellation>();

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.manifest = options.manifest;
    this.id = options.manifest.id;
    if (!this.manifest.apiStyles.includes(OPENAI_CHAT_COMPLETIONS_STYLE)) {
      throw new Error(
        `Provider ${this.id} does not declare ${OPENAI_CHAT_COMPLETIONS_STYLE}; ` +
          "the generic OpenAI-compatible adapter refuses to approximate another wire",
      );
    }
    const baseUrl = (options.baseUrl ?? this.manifest.baseUrl)?.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error(
        `Provider ${this.id} has no effective base URL: set providers.${this.id}.baseUrl in config`,
      );
    }
    this.discoveryPath = options.discoveryPath ?? this.manifest.discovery.path;
    this.client =
      options.client ??
      new OpenAiCompatibleClient({
        baseUrl,
        secretEnv: options.secretEnv ?? this.manifest.auth.secretEnv,
        providerLabel: this.manifest.displayName,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      });
  }

  get manifestRef(): ProviderManifest {
    return this.manifest;
  }

  private requireSecret(): void {
    this.client.readSecret();
  }

  /**
   * Administrative, non-inference catalog read. Discovery is the only source of
   * model ids: the Router never carries a hardcoded provider catalog. Returns
   * an empty catalog when the provider is not configured to be routable, which
   * keeps the provider registered (health/profile visible) while exposing no
   * route that could spend.
   */
  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    if (this.manifest.activation.mode === "none") return [];
    this.requireSecret();
    const data = await this.client.listModels(this.discoveryPath, signal);
    const discovered: DiscoveredModel[] = [];
    for (const entry of data) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : null;
      if (id === null || id.length === 0) continue;
      discovered.push({
        id: `${this.id}/${id}`,
        provider: this.id,
        // Exact provider model id: never normalized, prefixed or aliased.
        upstreamModel: id,
        displayName:
          typeof record.name === "string" && record.name.length > 0 ? record.name : id,
        capability: this.manifest.toolCapability,
      });
    }
    return discovered;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    if (this.manifest.activation.mode === "none") {
      return {
        status: "degraded",
        detail: `${this.manifest.displayName} routes are not activated pending an exact model id`,
      };
    }
    try {
      await this.discoverModels(signal);
      return { status: "ready", detail: `${this.manifest.displayName} discovery reachable` };
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
    if (request.model.provider !== this.id) {
      yield {
        type: "error",
        error: new RouterError(
          "unknown_model",
          `Model ${request.model.id} does not belong to provider ${this.id}`,
        ),
      };
      return;
    }
    if (!isActivatedModel(this.manifest, request.model.upstreamModel)) {
      // Activation is an exact, fail-closed gate: an unactivated route never
      // reaches the provider and therefore never spends.
      yield {
        type: "error",
        error: new RouterError(
          "unknown_model",
          `${this.manifest.displayName} route ${request.model.upstreamModel} is not activated`,
        ),
      };
      return;
    }

    try {
      this.requireSecret();
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_auth_required", String(error)),
      };
      return;
    }

    const abortController = new AbortController();
    const onOuterAbort = (): void => abortController.abort();
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    this.pending.set(request.requestId, { abort: () => abortController.abort() });

    const declaredToolNames = new Set(request.tools.map((tool) => tool.function.name));
    const toolState = new Map<number, { id: string; name?: string | undefined }>();
    let terminal: "stop" | "length" | "tool_calls" | undefined;
    let sawRecord = false;

    try {
      const upstreamOptions = {
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        ...(request.tools.length > 0 ? { tools: toUpstreamTools(request) } : {}),
        ...(request.toolChoice !== undefined
          ? { toolChoice: toChatWireToolChoice(request.toolChoice) }
          : {}),
        ...(request.parallelToolCalls !== undefined
          ? { parallelToolCalls: request.parallelToolCalls }
          : {}),
      };

      for await (const record of this.client.streamChatCompletion(
        request.model.upstreamModel,
        toUpstreamMessages(request),
        abortController.signal,
        upstreamOptions,
      )) {
        sawRecord = true;
        if (signal.aborted || abortController.signal.aborted) return;

        const upstreamError = record.error;
        if (upstreamError !== undefined && upstreamError !== null) {
          yield {
            type: "error",
            error: new RouterError(
              "provider_protocol_error",
              `${this.manifest.displayName} stream returned an upstream error object`,
            ),
          };
          return;
        }

        const choices = Array.isArray(record.choices) ? record.choices : [];
        const choice =
          choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null
            ? (choices[0] as Record<string, unknown>)
            : undefined;
        const delta =
          choice && typeof choice.delta === "object" && choice.delta !== null
            ? (choice.delta as Record<string, unknown>)
            : undefined;

        if (delta && typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", text: delta.content };
        }

        const toolCalls = delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawCall of toolCalls) {
          if (typeof rawCall !== "object" || rawCall === null) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                `${this.manifest.displayName} tool call fragment is not an object`,
              ),
            };
            return;
          }
          const call = rawCall as Record<string, unknown>;
          const index =
            typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0
              ? call.index
              : undefined;
          if (index === undefined) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                `${this.manifest.displayName} tool call fragment has no valid upstream index`,
              ),
            };
            return;
          }
          const fn =
            typeof call.function === "object" && call.function !== null
              ? (call.function as Record<string, unknown>)
              : undefined;
          const incomingId =
            typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
          const incomingName =
            fn && typeof fn.name === "string" && fn.name.length > 0 ? fn.name : undefined;
          const existing = toolState.get(index);

          if (existing && incomingId !== undefined && incomingId !== existing.id) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                `${this.manifest.displayName} tool id changed mid-stream for one index`,
              ),
            };
            return;
          }
          if (!existing && incomingId === undefined) {
            // A synthesized id would let a malformed frame masquerade as a real
            // tool call, so missing identity fails closed.
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                `${this.manifest.displayName} tool fragment is missing id for a new index`,
              ),
            };
            return;
          }

          const resolved = existing ?? { id: incomingId as string };
          if (existing && incomingName !== undefined) {
            if (existing.name !== undefined && existing.name !== incomingName) {
              yield {
                type: "error",
                error: new RouterError(
                  "provider_protocol_error",
                  `${this.manifest.displayName} tool name changed mid-stream`,
                ),
              };
              return;
            }
            if (existing.name === undefined) existing.name = incomingName;
          } else if (!existing) {
            const created: { id: string; name?: string | undefined } = {
              id: incomingId as string,
            };
            if (incomingName !== undefined) created.name = incomingName;
            toolState.set(index, created);
          }

          const settled = toolState.get(index)!;
          // Declared-tool ACL: the Router only ever surfaces calls the caller
          // declared, so an undeclared upstream name fails the request closed.
          if (settled.name !== undefined && !declaredToolNames.has(settled.name)) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                `${this.manifest.displayName} returned a tool call that was not declared in this request`,
              ),
            };
            return;
          }

          yield {
            type: "tool_call_delta",
            index,
            id: settled.id,
            ...(settled.name !== undefined ? { name: settled.name } : {}),
            ...(fn && typeof fn.arguments === "string" ? { argumentsDelta: fn.arguments } : {}),
          };
        }

        const usage =
          typeof record.usage === "object" && record.usage !== null
            ? (record.usage as Record<string, unknown>)
            : undefined;
        if (usage) {
          const promptDetails =
            typeof usage.prompt_tokens_details === "object" &&
            usage.prompt_tokens_details !== null
              ? (usage.prompt_tokens_details as Record<string, unknown>)
              : undefined;
          const completionDetails =
            typeof usage.completion_tokens_details === "object" &&
            usage.completion_tokens_details !== null
              ? (usage.completion_tokens_details as Record<string, unknown>)
              : undefined;
          const inputTokens = finiteNumber(usage.prompt_tokens);
          const outputTokens = finiteNumber(usage.completion_tokens);
          const cacheReadTokens = finiteNumber(promptDetails?.cached_tokens);
          const reasoningTokens = finiteNumber(completionDetails?.reasoning_tokens);
          const costUsd = finiteNumber(usage.cost);
          if (
            inputTokens !== undefined ||
            outputTokens !== undefined ||
            cacheReadTokens !== undefined ||
            reasoningTokens !== undefined ||
            costUsd !== undefined
          ) {
            yield {
              type: "usage",
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
              ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
              ...(costUsd !== undefined ? { costUsd } : {}),
            } as RouterEvent;
          }
        }

        const rawFinish = choice?.finish_reason;
        if (typeof rawFinish === "string" && rawFinish.length > 0) {
          terminal = finishReason(rawFinish);
          // Keep consuming: a usage-only chunk may follow the terminal reason.
        }
      }

      if (signal.aborted || abortController.signal.aborted) return;
      if (!sawRecord || terminal === undefined) {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            `${this.manifest.displayName} stream ended without a terminal finish reason`,
          ),
        };
        return;
      }
      yield { type: "completed", finishReason: terminal };
    } catch (error) {
      if (signal.aborted || abortController.signal.aborted) return;
      if (error instanceof RouterError) {
        yield { type: "error", error };
        return;
      }
      if ((error as Error)?.name === "AbortError") return;
      yield {
        type: "error",
        error: new RouterError(
          "provider_unavailable",
          `${this.manifest.displayName} unreachable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
      this.pending.delete(request.requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.pending.get(requestId)?.abort();
    this.pending.delete(requestId);
  }
}
