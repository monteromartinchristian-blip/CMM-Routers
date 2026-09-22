import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../core/provider.js";
import type { DiscoveredModel } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";

/**
 * Scripted CHAT_AND_TOOLS test double for the compiled-process E2E only.
 *
 * Registered exclusively when CMM_TEST_PROVIDER=scripted-tools is set; normal
 * production never sets it. It serves one canned tool-capable model with a
 * deterministic two-step client-owned round trip: it emits a structured tool
 * call, and when the client returns the result it derives the final answer from
 * it. No network, no quota, no secrets, and it never executes the tool.
 */
export class ScriptedToolAdapter implements ProviderAdapter {
  readonly id = "command-code" as const;

  static readonly MODEL_ID = "command-code/scripted-tool-model";
  static readonly TOOL_NAME = "cmm_echo";
  static readonly TOOL_CALL_ID = "scripted_call_1";

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: ScriptedToolAdapter.MODEL_ID,
        provider: "command-code",
        upstreamModel: "scripted-tool-model",
        displayName: "Scripted Tool Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready", detail: "scripted tool test double" };
  }

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    if (signal.aborted) return;

    const toolResults = request.messages.filter((message) => message.role === "tool");
    if (toolResults.length === 0) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: ScriptedToolAdapter.TOOL_CALL_ID,
        name: ScriptedToolAdapter.TOOL_NAME,
        argumentsDelta: '{"text":"scripted-arg"}',
      };
      yield { type: "usage", inputTokens: 5, outputTokens: 7 };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    const content = toolResults.map((message) => message.content ?? "").join("|");
    const ids = toolResults.map((message) => message.toolCallId ?? "").join(",");
    yield { type: "text_delta", text: `scripted-final[ids=${ids}][results=${content}]` };
    yield { type: "usage", inputTokens: 6, outputTokens: 9 };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}
