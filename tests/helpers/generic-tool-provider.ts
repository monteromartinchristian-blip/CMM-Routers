import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { DiscoveredModel, ProviderId } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { RouterError } from "../../src/core/errors.js";

/**
 * Deterministic CHAT_AND_TOOLS provider double used to prove the canonical
 * client-agnostic Code Router protocol without any network, quota or secret.
 *
 * It behaves like a stateless OpenAI-compatible provider: the caller re-sends
 * the whole conversation, so the double decides what to emit from the message
 * history it receives. Every turn is recorded so a test can assert exactly what
 * reached the provider — in particular that the declared tools, the forwarded
 * tool policy, the assistant tool-call history and the tool-result ids were all
 * preserved by the Router.
 */
export interface GenericToolTurnRecord {
  requestId: string;
  modelId: string;
  declaredTools: string[];
  toolChoice: unknown;
  parallelToolCalls: boolean | undefined;
  /** Assistant tool-call id groups seen in this request's history. */
  assistantToolCallIds: string[][];
  /** Tool results seen in this request's history, in order. */
  toolResults: Array<{
    id: string | undefined;
    content: string | null;
    status: "success" | "error" | undefined;
  }>;
  /** How many assistant tool-call rounds preceded this request. */
  rounds: number;
}

export type GenericToolScriptStep =
  | { kind: "calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | { kind: "final"; prefix: string };

export interface GenericToolProviderOptions {
  provider: ProviderId;
  modelId: string;
  /** Defaults to CHAT_AND_TOOLS; set CHAT_ONLY to prove fail-closed behavior. */
  capability?: "CHAT_AND_TOOLS" | "CHAT_ONLY";
  steps: GenericToolScriptStep[];
  /** Extra discovered models (e.g. a CHAT_ONLY sibling) on the same provider. */
  extraModels?: DiscoveredModel[];
}

function roundsOf(request: RouterRequest): number {
  return request.messages.filter(
    (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
  ).length;
}

export class GenericToolProvider implements ProviderAdapter {
  readonly id: ProviderId;
  readonly turns: GenericToolTurnRecord[] = [];
  runCount = 0;

  private readonly modelId: string;
  private readonly capability: "CHAT_AND_TOOLS" | "CHAT_ONLY";
  private readonly steps: GenericToolScriptStep[];
  private readonly extraModels: DiscoveredModel[];

  constructor(options: GenericToolProviderOptions) {
    this.id = options.provider;
    this.modelId = options.modelId;
    this.capability = options.capability ?? "CHAT_AND_TOOLS";
    this.steps = options.steps;
    this.extraModels = options.extraModels ?? [];
  }

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: this.modelId,
        provider: this.id,
        upstreamModel: this.modelId.slice(this.modelId.indexOf("/") + 1),
        displayName: "Generic Tool Model",
        capability: this.capability,
      },
      ...this.extraModels,
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.runCount += 1;
    const rounds = roundsOf(request);
    this.turns.push({
      requestId: request.requestId,
      modelId: request.model.id,
      declaredTools: request.tools.map((tool) => tool.function.name),
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      assistantToolCallIds: request.messages
        .filter((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
        .map((message) => (message.toolCalls ?? []).map((call) => call.id)),
      toolResults: request.messages
        .filter((message) => message.role === "tool")
        .map((message) => ({
          id: message.toolCallId,
          content: message.content,
          status: message.toolResultStatus,
        })),
      rounds,
    });

    const step = this.steps[Math.min(rounds, this.steps.length - 1)];
    if (step === undefined) {
      throw new RouterError(
        "provider_protocol_error",
        "generic double was configured without a script step",
      );
    }

    if (step.kind === "calls") {
      for (const [index, call] of step.calls.entries()) {
        yield {
          type: "tool_call_delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        };
      }
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    // Final turn: the answer is causally derived from what only the client
    // could have supplied — the tool-result contents and their ids.
    const results = request.messages.filter((message) => message.role === "tool");
    const ids = results.map((message) => message.toolCallId ?? "").join(",");
    const contents = results.map((message) => message.content ?? "").join("|");
    yield { type: "text_delta", text: `${step.prefix}[ids=${ids}][results=${contents}]` };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}
