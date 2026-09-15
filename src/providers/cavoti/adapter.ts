import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import type { ProviderConnection } from "../../catalog/types.js";
import type { ResolvedSecret } from "../../catalog/secure-credential-resolver.js";
import { toChatWireToolChoice } from "../../core/tool-policy.js";
import {
  CAVOTI_DEFAULT_BASE_URL,
  CAVOTI_DEFAULT_SECRET_ENV,
  CAVOTI_PINNED_MODEL,
  CavotiClient,
  cavotiUsageNumber,
  type CavotiClientLike,
} from "./client.js";
import {
  defaultCavotiAckPath,
  requireCavotiSpendAcknowledgement,
} from "./spend-guard.js";

export {
  CAVOTI_DEFAULT_BASE_URL,
  CAVOTI_DEFAULT_SECRET_ENV,
  CAVOTI_PINNED_MODEL,
};

export interface CavotiAdapterOptions {
  baseUrl?: string | undefined;
  secretEnv?: string | undefined;
  ackPath?: string | undefined;
  client?: CavotiClientLike | undefined;
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
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));
    }
    return base;
  });
}

function toUpstreamTools(request: RouterRequest): unknown[] | undefined {
  if (request.tools.length === 0) return undefined;
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

function topLevelError(record: Record<string, unknown>): RouterError | null {
  const raw = record.error;
  if (raw === undefined || raw === null) return null;
  return new RouterError(
    "provider_protocol_error",
    "Cavoti stream returned an upstream error object",
  );
}

export class CavotiAdapter implements ProviderAdapter {
  readonly id = "cavoti" as const;
  readonly executionCapabilities = { exactResolvedRoute: true } as const;
  private readonly client: CavotiClientLike;
  private readonly ackPath: string;
  private readonly expectedBaseUrl: string;
  private readonly pending = new Map<string, PendingCancellation>();

  constructor(options: CavotiAdapterOptions = {}) {
    this.ackPath = options.ackPath ?? defaultCavotiAckPath();
    this.expectedBaseUrl = (options.baseUrl ?? CAVOTI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.client =
      options.client ??
      new CavotiClient({
        baseUrl: options.baseUrl,
        secretEnv: options.secretEnv,
      });
  }

  private requireEnabled(): void {
    requireCavotiSpendAcknowledgement(this.ackPath);
    this.client.readSecret();
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    this.requireEnabled();
    const models = await this.client.listModels(signal);
    if (!models.some((model) => model.id === CAVOTI_PINNED_MODEL)) {
      throw new RouterError(
        "unknown_model",
        `Cavoti catalog does not contain exact pinned model ${CAVOTI_PINNED_MODEL}`,
      );
    }
    return [
      {
        id: `cavoti/${CAVOTI_PINNED_MODEL}`,
        provider: "cavoti",
        upstreamModel: CAVOTI_PINNED_MODEL,
        displayName: "DeepSeek V4.1 Flash (Cavoti)",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await this.discoverModels(signal);
      return { status: "ready", detail: "Cavoti exact pinned PAYG route verified" };
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

  async *run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    if (
      request.model.provider !== "cavoti" ||
      request.model.upstreamModel !== CAVOTI_PINNED_MODEL
    ) {
      yield {
        type: "error",
        error: new RouterError(
          "unknown_model",
          `Cavoti route is pinned to ${CAVOTI_PINNED_MODEL}; no alias or fallback is permitted`,
        ),
      };
      return;
    }

    try {
      this.requireEnabled();
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_auth_required", "Cavoti route is not enabled"),
      };
      return;
    }

    yield* this.runWithClient(request, signal, this.client);
  }

  async *runWithResolvedExecution(
    request: RouterRequest,
    signal: AbortSignal,
    connection: Readonly<ProviderConnection>,
    executionProfile: string,
    credential: Readonly<ResolvedSecret>,
  ): AsyncIterable<RouterEvent> {
    const endpoint = connection.endpointRef?.replace(/\/+$/, "");
    if (
      request.model.provider !== this.id ||
      request.model.upstreamModel !== CAVOTI_PINNED_MODEL ||
      connection.providerId !== this.id ||
      connection.connectionKind !== "openai-chat-completions" ||
      connection.profileRef !== undefined ||
      executionProfile !== "default" ||
      endpoint === undefined ||
      endpoint !== this.expectedBaseUrl ||
      credential.value.length === 0
    ) {
      yield {
        type: "error",
        error: new RouterError("unknown_model", "Unknown or unavailable route"),
      };
      return;
    }

    try {
      requireCavotiSpendAcknowledgement(this.ackPath);
      const routeClient = this.client.forExecution?.(endpoint, credential.value);
      if (routeClient === undefined) {
        yield {
          type: "error",
          error: new RouterError("unknown_model", "Unknown or unavailable route"),
        };
        return;
      }
      routeClient.readSecret();
      yield* this.runWithClient(request, signal, routeClient);
    } catch (error) {
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_auth_required", "Cavoti route is not enabled"),
      };
    }
  }

  private async *runWithClient(
    request: RouterRequest,
    signal: AbortSignal,
    client: CavotiClientLike,
  ): AsyncIterable<RouterEvent> {

    const abortController = new AbortController();
    const onOuterAbort = (): void => abortController.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });
    this.pending.set(request.requestId, { abort: () => abortController.abort() });

    try {
      const declaredToolNames = new Set(
        request.tools.map((tool) => tool.function.name),
      );
      const toolState = new Map<
        number,
        { id: string; name?: string | undefined }
      >();
      let terminal: "stop" | "length" | "tool_calls" | undefined;
      let sawAnyRecord = false;
      const upstreamTools = toUpstreamTools(request);

      const generator = client.streamChatCompletion(
        CAVOTI_PINNED_MODEL,
        toUpstreamMessages(request),
        abortController.signal,
        {
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(upstreamTools !== undefined ? { tools: upstreamTools } : {}),
          ...(request.toolChoice !== undefined
            ? { toolChoice: toChatWireToolChoice(request.toolChoice) }
            : {}),
          ...(request.parallelToolCalls !== undefined
            ? { parallelToolCalls: request.parallelToolCalls }
            : {}),
        },
      );

      for await (const record of generator) {
        sawAnyRecord = true;
        if (signal.aborted || abortController.signal.aborted) return;

        const upstreamError = topLevelError(record);
        if (upstreamError) {
          yield { type: "error", error: upstreamError };
          return;
        }

        const choices = Array.isArray(record.choices) ? record.choices : [];
        const choice =
          choices.length > 0 &&
          typeof choices[0] === "object" &&
          choices[0] !== null
            ? (choices[0] as Record<string, unknown>)
            : undefined;
        const delta =
          choice &&
          typeof choice.delta === "object" &&
          choice.delta !== null
            ? (choice.delta as Record<string, unknown>)
            : undefined;

        if (delta && typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", text: delta.content };
        }

        const toolCalls =
          delta && Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawCall of toolCalls) {
          if (typeof rawCall !== "object" || rawCall === null) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                "Cavoti tool call fragment is not an object",
              ),
            };
            return;
          }
          const call = rawCall as Record<string, unknown>;
          const index =
            typeof call.index === "number" && Number.isInteger(call.index)
              ? call.index
              : undefined;
          if (index === undefined || index < 0) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                "Cavoti tool call fragment has no valid upstream index",
              ),
            };
            return;
          }

          const fn =
            typeof call.function === "object" && call.function !== null
              ? (call.function as Record<string, unknown>)
              : undefined;
          const incomingId =
            typeof call.id === "string" && call.id.length > 0
              ? call.id
              : undefined;
          const incomingName =
            fn && typeof fn.name === "string" && fn.name.length > 0
              ? fn.name
              : undefined;
          const existing = toolState.get(index);

          if (existing && incomingId && incomingId !== existing.id) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                "Cavoti tool id changed mid-stream for one upstream index",
              ),
            };
            return;
          }
          if (!existing && !incomingId) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                "Cavoti tool fragment is missing id for a new upstream index",
              ),
            };
            return;
          }

          const resolved = existing ?? {
            id: incomingId as string,
            ...(incomingName !== undefined ? { name: incomingName } : {}),
          };
          if (existing && incomingName !== undefined) {
            if (existing.name !== undefined && existing.name !== incomingName) {
              yield {
                type: "error",
                error: new RouterError(
                  "provider_protocol_error",
                  "Cavoti tool name changed mid-stream",
                ),
              };
              return;
            }
            if (existing.name === undefined) existing.name = incomingName;
          }
          toolState.set(index, resolved);

          if (
            resolved.name !== undefined &&
            !declaredToolNames.has(resolved.name)
          ) {
            yield {
              type: "error",
              error: new RouterError(
                "provider_protocol_error",
                "Cavoti returned a tool call that was not declared in this request",
              ),
            };
            return;
          }

          yield {
            type: "tool_call_delta",
            index,
            id: resolved.id,
            ...(resolved.name !== undefined ? { name: resolved.name } : {}),
            ...(fn && typeof fn.arguments === "string"
              ? { argumentsDelta: fn.arguments }
              : {}),
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

          const inputTokens = cavotiUsageNumber(usage.prompt_tokens);
          const outputTokens = cavotiUsageNumber(usage.completion_tokens);
          const cacheReadTokens = cavotiUsageNumber(promptDetails?.cached_tokens);
          const reasoningTokens = cavotiUsageNumber(
            completionDetails?.reasoning_tokens ?? usage.reasoning_tokens,
          );
          const costUsd = cavotiUsageNumber(usage.cost ?? record.cost);

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
          // Keep consuming: include_usage can emit one final usage-only chunk.
        }
      }

      if (signal.aborted || abortController.signal.aborted) return;
      if (!sawAnyRecord || terminal === undefined) {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            "Cavoti stream ended without a terminal finish reason",
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
          `Cavoti unreachable: ${error instanceof Error ? error.message : String(error)}`,
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
