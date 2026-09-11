import { describe, expect, it } from "vitest";
import { BridgeControlServer, BridgeControlClient } from "../../src/bridge/control-ipc.js";

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

/**
 * Every tool-related pending container must be bounded, with a deterministic
 * safe error on overflow. A finite TTL alone is not a maximum under burst load.
 */
describe("bridge control pending state is bounded", () => {
  it("refuses new parked frames past the per-session maximum", async () => {
    const accepted: string[] = [];
    const server = await BridgeControlServer.listen({
      onToolCall: (request) => accepted.push(request.id),
      maxPending: 16,
      pendingTtlMs: 500,
    });
    const client = new BridgeControlClient(server.socketPath, server.token);
    const settled: Array<Promise<string>> = [];
    try {
      // Fire a burst far larger than the declared maximum.
      for (let index = 0; index < 40; index += 1) {
        settled.push(
          client.request(`burst-${index}`, "cmm_echo", { text: "x" }).then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
          ),
        );
      }
      await waitFor(() => accepted.length >= 16);

      // The server must never hold more than its declared maximum.
      expect(server.pendingCount()).toBeLessThanOrEqual(16);
      expect(accepted.length).toBeLessThanOrEqual(16);
      console.log("BRIDGE_CONTROL_PENDING_BOUND=PASS");

      // Overflow must be a deterministic rejection, never a silent drop.
      const overflow = await waitForRejection(settled);
      expect(overflow.some((r) => r.includes("bounded"))).toBe(true);
      console.log("GLOBAL_TOOL_PENDING_STATE_BOUNDED=PASS");

      // A parked-but-unanswered call cannot live forever either.
      await waitFor(() => server.pendingCount() === 0);
      const all = await Promise.all(settled);
      expect(all.filter((r) => r.includes("expired")).length).toBeGreaterThan(0);
    } finally {
      await server.close().catch(() => undefined);
    }
  }, 30000);
});

/** Resolves once at least one burst request settled with a rejection. */
async function waitForRejection(settled: Array<Promise<string>>): Promise<string[]> {
  const results = await Promise.all(settled);
  return results.filter((r) => r.startsWith("rejected:"));
}
