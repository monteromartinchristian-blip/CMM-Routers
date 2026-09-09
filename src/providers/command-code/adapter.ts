import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import {
  ANTHROPIC_MESSAGES_PATH,
  CommandCodeClient,
  DEFAULT_BASE_URL,
  DEFAULT_SECRET_ENV,
  OPENAI_CHAT_COMPLETIONS_PATH,
  parseAnthropicStreamEvents,
  parseSseDataLine,
  type CommandCodeWire,
} from "./client.js";
import {
  DEFAULT_ACK_PATH,
  assertNoSpendPath,
  requireSpendAcknowledgement,
} from "./spend-guard.js";

export { DEFAULT_ACK_PATH, DEFAULT_BASE_URL, DEFAULT_SECRET_ENV };
export type { CommandCodeWire };

export const COMMAND_CODE_WIRES: Record<CommandCodeWire, { path: string }> = {
  "openai-chat-completions": { path: OPENAI_CHAT_COMPLETIONS_PATH },
  "anthropic-messages": { path: ANTHROPIC_MESSAGES_PATH },
};

export interface CommandCodeAdapterOptions {
  baseUrl?: string | undefined;
  secretEnv?: string | undefined;
  ackPath?: string | undefined;
  client?: CommandCodeClient | undefined;
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
    return base;
  });
}

function toUpstreamTools(request: RouterRequest): unknown[] | undefined {
  if (request.tools.length === 0) return undefined;
  return request.tools.map((tool) => ({
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

export class CommandCodeAdapter implements ProviderAdapter {
  readonly id = "command-code" as const;
  private readonly client: CommandCodeClient;
  private readonly ackPath: string;
  private readonly pending = new Map<string, PendingCancellation>();

  constructor(options: CommandCodeAdapterOptions = {}) {
    this.ackPath = options.ackPath ?? DEFAULT_ACK_PATH;
    this.client =
      options.client ??
      new CommandCodeClient({ baseUrl: options.baseUrl, secretEnv: options.secretEnv });
  }

  private requireEnabled(): void {
    requireSpendAcknowledgement(this.ackPath);
    this.client.readSecret();
  }

  wireForModel(model: DiscoveredModel): CommandCodeWire {
    const meta = (model as DiscoveredModel & { wire?: unknown }).wire;
    if (meta === "anthropic-messages" || meta === "openai-chat-completions") {
      return meta;
    }
    return this.client.wireForUpstreamId(model.upstreamModel);
  }

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    void signal;
    this.requireEnabled();
    const models = await this.client.listModels(signal);
    if (models.length === 0) {
      throw new RouterError(
        "provider_protocol_error",
        "Command Code model discovery returned no usable models",
      );
    }
    const seen = new Set<string>();
    const discovered: DiscoveredModel[] = [];
    for (const model of models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      discovered.push({
        id: `command-code/${model.id}`,
        provider: "command-code",
        upstreamModel: model.id,
        displayName: model.displayName ?? model.id,
        capability: "CHAT_ONLY",
        wire: model.wire,
        ...(model.family !== undefined ? { family: model.family } : {}),
        goatIncluded: model.goatIncluded,
      } as DiscoveredModel);
    }
    return discovered;
  }

  /**
   * GOAT-usable subset of discovery. GET /models is a GLOBAL catalog, not a
   * plan entitlement list: only entries with authoritative GOAT-inclusion
   * metadata (goatIncluded === true) qualify. Entries with null metadata
   * are catalog-only until proven otherwise — never assumed plan-usable.
   */
  goatUsableModels(models: DiscoveredModel[]): DiscoveredModel[] {
    return models.filter(
      (model) =>
        (model as DiscoveredModel & { goatIncluded?: unknown }).goatIncluded === true,
    );
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await this.discoverModels(signal);
      return { status: "ready", detail: "Command Code GOAT provider reachable" };
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
      this.requireEnabled();
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

    assertNoSpendPath(request.model.upstreamModel);

    // Deterministic single-wire routing decided BEFORE any request.
    // Retrying the other endpoint after an upstream error is FORBIDDEN.
    const wire = this.wireForModel(request.model);

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.pending.set(request.requestId, { abort: () => abortController.abort() });

    try {
      if (wire === "anthropic-messages") {
        yield* this.runAnthropicWire(request, abortController.signal, signal);
        return;
      }
      yield* this.runOpenAiWire(request, abortController.signal, signal);
      return;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(request.requestId);
    }
  }

  private async *runOpenAiWire(
    request: RouterRequest,
    abortSignal: AbortSignal,
    outerSignal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    try {
      const upstreamTools = toUpstreamTools(request);
      const generator = this.client.streamChatCompletion(
        request.model.upstreamModel,
        toUpstreamMessages(request) as never,
        abortSignal,
        {
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens as number }
            : {}),
          ...(upstreamTools !== undefined ? { tools: upstreamTools as unknown[] } : {}),
        },
      );

      let sawCompletion = false;
      let toolCallIndex = 0;
      for await (const chunk of generator) {
        if (outerSignal.aborted || abortSignal.aborted) return;
        const data = parseSseDataLine(chunk);
        if (data === null) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(data) as unknown;
        } catch {
          yield {
            type: "error",
            error: new RouterError(
              "provider_protocol_error",
              `Malformed Command Code SSE payload: ${data.slice(0, 200)}`,
            ),
          };
          return;
        }
        if (!payload || typeof payload !== "object") continue;
        const record = payload as Record<string, unknown>;
        if (typeof record.error === "object" && record.error !== null) {
          const message =
            (record.error as Record<string, unknown>).message ?? "Command Code error";
          yield {
            type: "error",
            error: new RouterError("provider_protocol_error", String(message).slice(0, 300)),
          };
          return;
        }
        const choices = Array.isArray(record.choices) ? record.choices : [];
        const choice = choices[0] as Record<string, unknown> | undefined;
        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", text: delta.content };
          }
          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const call of toolCalls) {
            const callRecord = call as Record<string, unknown>;
            const fn = callRecord.function as Record<string, unknown> | undefined;
            const toolDelta: RouterEvent = {
              type: "tool_call_delta",
              index: toolCallIndex++,
              id: typeof callRecord.id === "string" ? callRecord.id : `call-${toolCallIndex}`,
              ...(typeof fn?.name === "string" ? { name: fn.name as string } : {}),
              ...(typeof fn?.arguments === "string"
                ? { argumentsDelta: fn.arguments as string }
                : {}),
            };
            yield toolDelta;
          }
        }
        const usage = record.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          const num = (v: unknown): number | undefined =>
            typeof v === "number" && Number.isFinite(v) ? v : undefined;
          const inputTokens = num(usage.prompt_tokens);
          const outputTokens = num(usage.completion_tokens);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            const usageEvent: RouterEvent = { type: "usage" };
            if (inputTokens !== undefined) (usageEvent as { inputTokens?: number }).inputTokens = inputTokens;
            if (outputTokens !== undefined) (usageEvent as { outputTokens?: number }).outputTokens = outputTokens;
            yield usageEvent;
          }
        }
        const finishReason = choice?.finish_reason;
        if (typeof finishReason === "string" && finishReason.length > 0) {
          sawCompletion = true;
          if (finishReason === "tool_calls") {
            yield { type: "completed", finishReason: "tool_calls" };
          } else if (finishReason === "length") {
            yield { type: "completed", finishReason: "length" };
          } else {
            yield { type: "completed", finishReason: "stop" };
          }
          return;
        }
      }

      if (outerSignal.aborted || abortSignal.aborted) return;
      if (!sawCompletion) {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            "Command Code stream ended without terminal finish reason",
          ),
        };
      }
    } catch (error) {
      if (outerSignal.aborted || abortSignal.aborted) return;
      if (error instanceof RouterError) {
        yield { type: "error", error };
      } else if ((error as Error).name === "AbortError") {
        return;
      } else {
        yield {
          type: "error",
          error: new RouterError(
            "provider_unavailable",
            `Command Code unreachable: ${(error as Error).message}`,
          ),
        };
      }
    }
  }

  private async *runAnthropicWire(
    request: RouterRequest,
    abortSignal: AbortSignal,
    outerSignal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    // Anthropic wire accepts no OpenAI-only fields (no tools passthrough here).
    try {
      const messages = toUpstreamMessages(request).map((message) => ({
        role: String(message.role),
        content: message.content,
        ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
        ...(typeof message.name === "string" ? { name: message.name } : {}),
      })) as never;
      const generator = this.client.streamAnthropicMessages(
        request.model.upstreamModel,
        messages,
        abortSignal,
        request.maxOutputTokens,
      );

      let buffered = "";
      let firstChunk = true;
      for await (const chunk of generator) {
        if (outerSignal.aborted || abortSignal.aborted) return;
        if (!firstChunk) buffered += "\n\n";
        firstChunk = false;
        buffered += chunk;
      }
      if (outerSignal.aborted || abortSignal.aborted) return;

      let state;
      try {
        state = parseAnthropicStreamEvents(buffered);
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

      if (state.error) {
        yield {
          type: "error",
          error: new RouterError("provider_protocol_error", state.error),
        };
        return;
      }
      for (const delta of state.textDeltas) {
        yield { type: "text_delta", text: delta };
      }
      if (state.inputTokens !== undefined || state.outputTokens !== undefined) {
        const usageEvent: RouterEvent = { type: "usage" };
        if (state.inputTokens !== undefined) {
          (usageEvent as { inputTokens?: number }).inputTokens = state.inputTokens;
        }
        if (state.outputTokens !== undefined) {
          (usageEvent as { outputTokens?: number }).outputTokens = state.outputTokens;
        }
        yield usageEvent;
      }
      if (state.completed) {
        if (state.stopReason === "max_tokens") {
          yield { type: "completed", finishReason: "length" };
        } else {
          yield { type: "completed", finishReason: "stop" };
        }
        return;
      }
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Command Code Anthropic stream ended without message_stop",
        ),
      };
    } catch (error) {
      if (outerSignal.aborted || abortSignal.aborted) return;
      if (error instanceof RouterError) {
        yield { type: "error", error };
      } else if ((error as Error).name === "AbortError") {
        return;
      } else {
        yield {
          type: "error",
          error: new RouterError(
            "provider_unavailable",
            `Command Code unreachable: ${(error as Error).message}`,
          ),
        };
      }
    }
  }

  async cancel(requestId: string): Promise<void> {
    const active = this.pending.get(requestId);
    if (!active) return;
    try {
      active.abort();
    } finally {
      this.pending.delete(requestId);
    }
  }
}
