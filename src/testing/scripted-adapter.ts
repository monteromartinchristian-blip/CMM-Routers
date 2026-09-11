import type {
  ProviderAdapter,
  ProviderHealth,
  RouterRequest,
} from "../core/provider.js";
import type { DiscoveredModel } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";

/**
 * Scripted in-process test double for the compiled-process E2E only.
 * Registered exclusively when CMM_TEST_PROVIDER=scripted is set; production
 * never enables it. Serves one canned chat model with deterministic text,
 * usage, and completion — no network, no quota, no secrets.
 */
export class ScriptedTestAdapter implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  private active = new Set<string>();

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/scripted-test-model",
        provider: "chatgpt",
        upstreamModel: "scripted-test-model",
        displayName: "Scripted Test Model",
        capability: "CHAT_ONLY",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready", detail: "scripted test double" };
  }

  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.active.add(request.requestId);
    try {
      if (signal.aborted) return;
      yield { type: "text_delta", text: "QODER_SMOKE_OK scripted reply" };
      if (signal.aborted) return;
      yield { type: "usage", inputTokens: 3, outputTokens: 5 };
      yield { type: "completed", finishReason: "stop" };
    } finally {
      this.active.delete(request.requestId);
    }
  }

  async cancel(requestId: string): Promise<void> {
    this.active.delete(requestId);
  }

  activeCount(): number {
    return this.active.size;
  }
}
