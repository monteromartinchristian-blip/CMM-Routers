import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * Real-socket disconnect proof: a live Fastify server, a real HTTP client
 * that destroys its socket mid-stream, and assertions that the SERVER
 * triggered provider abort + cancel() + UsageStore cleanup on its own.
 * The test never calls adapter.cancel() itself.
 */
class HangingStreamProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  cancelled: string[] = [];
  entered: string[] = [];
  sawAbort: string[] = [];
  release = new Map<string, () => void>();

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [{ id: "chatgpt/m", provider: "chatgpt", upstreamModel: "m", displayName: "M" }];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(request: RouterRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.entered.push(request.requestId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.release.set(request.requestId, release);
    const onAbort = (): void => {
      this.sawAbort.push(request.requestId);
    };
    if (signal.aborted) this.sawAbort.push(request.requestId);
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Stream one chunk so the client receives headers + first delta,
      // then stall forever until abort or release.
      yield { type: "text_delta", text: "early" };
      await Promise.race([
        gate,
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
      this.release.delete(request.requestId);
    }
  }
  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

const SECRET = "socket-disconnect-secret";

describe("real HTTP socket disconnect cancellation", () => {
  it(
    "destroying the client socket aborts the provider run via the server",
    { timeout: 30000 },
    async () => {
      const registry = new ProviderRegistry();
      const provider = new HangingStreamProvider();
      await registry.register(provider);
      await registry.refresh();
      const usageStore = new UsageStore();
      const server = buildServer({
        host: "127.0.0.1",
        port: 0,
        bearerSecret: SECRET,
        registry,
        usageStore,
      });
      await server.listen({ host: "127.0.0.1", port: 0 });
      const address = server.server.address();
      const port =
        typeof address === "object" && address !== null ? (address.port as number) : 0;
      expect(port).toBeGreaterThan(0);
      const dir = mkdtempSync(join(tmpdir(), "cmm-sock-"));
      try {
        // Real TCP client: open a streaming request, read headers + first
        // chunk, then destroy the socket mid-stream.
        const { request } = await import("node:http");
        const chunks: string[] = [];
        let firstChunkSeen!: () => void;
        const firstChunk = new Promise<void>((resolve) => {
          firstChunkSeen = resolve;
        });
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              authorization: `Bearer ${SECRET}`,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            res.on("data", (chunk: Buffer) => {
              chunks.push(chunk.toString("utf-8"));
              firstChunkSeen();
            });
            res.on("end", () => undefined);
            res.on("error", () => undefined);
          },
        );
        req.on("error", () => undefined);
        req.write(
          JSON.stringify({
            model: "chatgpt/m",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        );
        req.end();
        await firstChunk;
        expect(chunks.join("")).toContain("early");
        // Wait until the provider is stalled inside the run, then destroy.
        while (provider.entered.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        req.destroy();

        // The server must propagate WITHOUT any test-side cancel() call.
        const started = Date.now();
        while (
          (provider.sawAbort.length === 0 || provider.cancelled.length === 0) &&
          Date.now() - started < 10000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(provider.sawAbort.length).toBeGreaterThan(0);
        console.log("HTTP_SOCKET_DISCONNECT_PROPAGATION=PASS");
        console.log("PROVIDER_ABORT_FROM_SOCKET_CLOSE=PASS");
        expect(provider.cancelled.length).toBeGreaterThan(0);

        // Active-request bookkeeping must drain back to zero and no success
        // may be recorded for the killed request.
        const settled = Date.now();
        while (usageStore.aggregates().activeRequests !== 0 && Date.now() - settled < 10000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(usageStore.aggregates().activeRequests).toBe(0);
        expect(usageStore.aggregates().successCount).toBe(0);
        console.log("ACTIVE_REQUEST_CLEANUP=PASS");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await server.close();
      }
    },
  );
});
