import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterError } from "../../src/core/errors.js";

function validAck(dir: string): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    }),
  );
  return path;
}

function makeRequest(upstreamModel = "goat-model-a"): RouterRequest {
  return {
    requestId: "cc-timeout-001",
    model: {
      id: `command-code/${upstreamModel}`,
      provider: "command-code",
      upstreamModel,
      displayName: upstreamModel,
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

describe("Command Code timeout composition", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-timeout-"));
    ackPath = validAck(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("aborts a stalled upstream at the client timeout even with a caller signal", async () => {
    const exteriorSignals: Array<AbortSignal | undefined> = [];
    const client = new CommandCodeClient({
      secret: "s",
      timeoutMs: 50,
      fetchFn: (async (_url: string, init: { signal?: AbortSignal }) => {
        exteriorSignals.push(init.signal);
        // Stalled upstream: never resolves unless the signal aborts it.
        await new Promise<void>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          init.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
        return { status: 200, text: async () => "" };
      }) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(["provider_timeout", "provider_unavailable"]).toContain(errorEvent?.error.code);
    expect(exteriorSignals.length).toBeGreaterThan(0);
    expect(exteriorSignals[0]?.aborted).toBe(true);
  });

  it("caller cancellation still wins before the client timeout", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      timeoutMs: 10_000,
      fetchFn: (async (_url: string, init: { signal?: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
        return { status: 200, text: async () => "" };
      }) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const controller = new AbortController();
    const runPromise = (async () => {
      const events: unknown[] = [];
      for await (const event of adapter.run(makeRequest(), controller.signal)) {
        events.push(event);
      }
      return events;
    })();
    controller.abort();
    const events = await runPromise;
    expect(events.filter((e) => (e as { type: string }).type === "error")).toEqual([]);
  });
});
