import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import {
  CommandCodeClient,
  DEFAULT_BASE_URL,
  DEFAULT_SECRET_ENV,
  parseSseDataLine,
} from "./client.js";
import {
  DEFAULT_ACK_PATH,
  assertNoSpendPath,
  requireSpendAcknowledgement,
} from "./spend-guard.js";

export { DEFAULT_ACK_PATH, DEFAULT_BASE_URL, DEFAULT_SECRET_ENV };

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
      });
    }
    return discovered;
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

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.pending.set(request.requestId, { abort: () => abortController.abort() });

    try {
      const upstreamTools = toUpstreamTools(request);
      const generator = this.client.streamChatCompletion(
        request.model.upstreamModel,
        toUpstreamMessages(request) as never,
        abortController.signal,
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
        if (signal.aborted || abortController.signal.aborted) return;
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

      if (signal.aborted || abortController.signal.aborted) return;
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
      if (signal.aborted || abortController.signal.aborted) return;
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
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(request.requestId);
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
