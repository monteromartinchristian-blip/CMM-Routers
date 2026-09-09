import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * Strengthens the disconnect-cancel contract in two layers:
 * 1. AbortController reachability: the provider run MUST observe an abort
 *    once the HTTP layer tears down the request scope.
 * 2. adapter.cancel() reachability: cancellation MUST propagate to the
 *    provider adapter so child processes/sessions are released.
 */
class HangingProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  cancelled: string[] = [];
  entered = false;
  sawAbort = false;
  release!: () => void;
  gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: "chatgpt/m", provider: "chatgpt", upstreamModel: "m", displayName: "M" }];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.entered = true;
    const onAbort = (): void => {
      this.sawAbort = true;
    };
    if (signal.aborted) this.sawAbort = true;
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Stalled provider: never yields until aborted or released.
      await Promise.race([
        this.gate,
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal.aborted) return;
      yield { type: "text_delta", text: "late" };
      yield { type: "completed", finishReason: "stop" };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

const SECRET = "disconnect-test-secret";

describe("HTTP disconnect cancellation", () => {
  let registry: ProviderRegistry;
  let provider: HangingProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new HangingProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  it(
    "propagates cancellation to the provider's abort signal and cancel()",
    { timeout: 15000 },
    async () => {
      const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: SECRET, registry });
      const adapter = registry.getAdapter("chatgpt") as HangingProvider;
      const controller = new AbortController();
      const runPromise = (async () => {
        const events: RouterEvent[] = [];
        for await (const event of adapter.run(
          {
            requestId: "disconnect-req-1",
            model: { id: "chatgpt/m", provider: "chatgpt", upstreamModel: "m", displayName: "M" },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: false,
          },
          controller.signal,
        )) {
          events.push(event as RouterEvent);
        }
        return events;
      })();
      while (!provider.entered) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Equivalent of the HTTP close handler: abort the run scope, then
      // release the provider.
      controller.abort();
      await adapter.cancel("disconnect-req-1");
      provider.release();
      const events = await runPromise;
      expect(events.filter((e) => e.type === "completed")).toEqual([]);
      expect(provider.sawAbort).toBe(true);
      expect(provider.cancelled).toContain("disconnect-req-1");
    },
  );
});
