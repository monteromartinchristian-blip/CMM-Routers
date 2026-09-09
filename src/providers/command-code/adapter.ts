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
  parseAnthropicEvent,
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
      // KNOWN_EXCLUDED entries (authoritative exclusion metadata) are hidden
      // here: /v1/models and registry resolution must never advertise a model
      // the account metadata says is plan-excluded. UNKNOWN entries stay
      // visible and fail closed at request time via upstream plan enforcement.
      if (model.goatIncluded === false) continue;
      // Tool capability is wire-truthful: only the OpenAI chat-completions wire
      // carries tool definitions and parses tool_calls (Qoder-owned execution).
      // Anthropic-wire models cannot express this structured round-trip, so
      // they stay CHAT_ONLY. The OpenAI-wire round-trip is proven
      // deterministically (scripted /chat/completions E2E); live re-proof is
      // deferred to the post-audit live gate.
      const wire = model.wire ?? this.client.wireForUpstreamId(model.id);
      const capability = wire === "anthropic-messages" ? ("CHAT_ONLY" as const) : ("CHAT_AND_TOOLS" as const);
      discovered.push({
        id: `command-code/${model.id}`,
        provider: "command-code",
        upstreamModel: model.id,
        displayName: model.displayName ?? model.id,
        capability,
        wire: model.wire,
        ...(model.family !== undefined ? { family: model.family } : {}),
        goatIncluded: model.goatIncluded,
      } as DiscoveredModel);
    }
    if (discovered.length === 0) {
      throw new RouterError(
        "provider_protocol_error",
        "Command Code model discovery returned no usable models",
      );
    }
    return discovered;
  }

  /**
   * Entitlement tri-state for a discovered catalog entry. GET /models is a
   * GLOBAL catalog, not a plan list: entries with authoritative inclusion
   * metadata are KNOWN_INCLUDED, entries with authoritative exclusion
   * metadata are KNOWN_EXCLUDED, and bare entries (the observed live shape)
   * are UNKNOWN. UNKNOWN is never presented as proven-included; it stays
   * visible for deterministic routing and fails closed at request time via
   * upstream plan enforcement (MODEL_NOT_IN_PLAN → quota error, no spend).
   */
  entitlementOf(model: DiscoveredModel): "KNOWN_INCLUDED" | "KNOWN_EXCLUDED" | "UNKNOWN" {
    const flag = (model as DiscoveredModel & { goatIncluded?: unknown }).goatIncluded;
    if (flag === true) return "KNOWN_INCLUDED";
    if (flag === false) return "KNOWN_EXCLUDED";
    return "UNKNOWN";
  }

  /**
   * GOAT-usable subset of discovery: only entries with authoritative
   * GOAT-inclusion metadata (goatIncluded === true). Kept for the live
   * acceptance path, which must never select by catalog existence alone.
   */
  goatUsableModels(models: DiscoveredModel[]): DiscoveredModel[] {
    return models.filter((model) => this.entitlementOf(model) === "KNOWN_INCLUDED");
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
      if (error instanceof RouterError) {
        // Client-enforced deadline (provider_timeout) must surface: only
        // genuine caller cancellation returns silently.
        if (error.code === "provider_timeout" && !outerSignal.aborted && !abortSignal.aborted) {
          yield { type: "error", error };
          return;
        }
        if (outerSignal.aborted || abortSignal.aborted) return;
        yield { type: "error", error };
      } else if ((error as Error).name === "AbortError") {
        return;
      } else {
        if (outerSignal.aborted || abortSignal.aborted) return;
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
    // Frames yield incrementally as they arrive; completion only on message_stop.
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

      let carry = "";
      let sawStop = false;
      let stopReason: string | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let usageYielded = false;

      const emitUsage = function* (): Generator<RouterEvent> {
        if (usageYielded) return;
        if (inputTokens === undefined && outputTokens === undefined) return;
        usageYielded = true;
        const usageEvent: RouterEvent = { type: "usage" };
        if (inputTokens !== undefined) {
          (usageEvent as { inputTokens?: number }).inputTokens = inputTokens;
        }
        if (outputTokens !== undefined) {
          (usageEvent as { outputTokens?: number }).outputTokens = outputTokens;
        }
        yield usageEvent;
      };

      const handleFrame = function* (frame: string): Generator<RouterEvent> {
        // Chunks from the client are pre-split SSE frames; each may or may
        // not carry the "data:" prefix. parseSseDataLine handles both.
        const data = parseSseDataLine(frame);
        if (data === null) return;
        let parsed;
        try {
          parsed = parseAnthropicEvent(data);
        } catch (error) {
          yield {
            type: "error",
            error:
              error instanceof RouterError
                ? error
                : new RouterError("provider_protocol_error", String(error)),
          } as RouterEvent;
          return;
        }
        if (parsed.kind === "error") {
          yield {
            type: "error",
            error: new RouterError("provider_protocol_error", parsed.error ?? "Anthropic upstream error"),
          } as RouterEvent;
          return;
        }
        if (parsed.kind === "text" && parsed.text) {
          yield { type: "text_delta", text: parsed.text };
        }
        if (parsed.inputTokens !== undefined) inputTokens = parsed.inputTokens;
        if (parsed.outputTokens !== undefined) outputTokens = parsed.outputTokens;
        // Usage is emitted once before completion so ordering stays
        // text_delta(s) -> usage -> completed regardless of when the
        // upstream message_start/message_delta frames arrive.
        if (parsed.stopReason !== undefined) stopReason = parsed.stopReason;
        if (parsed.kind === "stop") sawStop = true;
      };

      for await (const chunk of generator) {
        if (outerSignal.aborted || abortSignal.aborted) return;
        // Client chunks are pre-split frames without delimiters; restore
        // the "\n\n" separator so frames never fuse into malformed JSON.
        carry += chunk + "\n\n";
        // Frames are \n\n-delimited; a chunk may hold partial or many frames.
        const frames = carry.split("\n\n");
        carry = frames.pop() ?? "";
        for (const frame of frames) {
          if (outerSignal.aborted || abortSignal.aborted) return;
          if (!frame.trim()) continue;
          let terminal = false;
          for (const event of handleFrame(frame)) {
            if (event.type === "error") {
              yield event;
              return;
            }
            if (event.type === "completed") {
              terminal = true;
              continue;
            }
            yield event;
          }
          void terminal;
          if (sawStop) break;
        }
        if (sawStop) break;
      }
      if (outerSignal.aborted || abortSignal.aborted) return;
      if (carry.trim()) {
        for (const event of handleFrame(carry)) {
          if (event.type === "error") {
            yield event;
            return;
          }
          if (event.type !== "completed") yield event;
        }
      }

      if (sawStop) {
        yield* emitUsage();
        if (stopReason === "max_tokens") {
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
      if (error instanceof RouterError) {
        // Client-enforced deadline (provider_timeout) must surface: only
        // genuine caller cancellation returns silently.
        if (error.code === "provider_timeout" && !outerSignal.aborted && !abortSignal.aborted) {
          yield { type: "error", error };
          return;
        }
        if (outerSignal.aborted || abortSignal.aborted) return;
        yield { type: "error", error };
      } else if ((error as Error).name === "AbortError") {
        return;
      } else {
        if (outerSignal.aborted || abortSignal.aborted) return;
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
