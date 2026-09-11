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
    requestId: "cc-body-timeout-001",
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

describe("Command Code full-stream deadline", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-body-"));
    ackPath = validAck(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "times out a body that stalls after headers and first chunk",
    { timeout: 15000 },
    async () => {
      const client = new CommandCodeClient({
        secret: "s",
        timeoutMs: 200,
        fetchFn: (async () => {
          // Headers arrive immediately with one SSE frame, then the body
          // hangs forever — the router deadline must still fire.
          async function* streamChunks() {
            yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
            await new Promise<void>(() => undefined);
          }
          return { status: 200, text: async () => "", streamChunks };
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
      expect(errorEvent?.error.code).toBe("provider_timeout");
      // The first chunk may or may not have been delivered before the
      // deadline; either way no completion must follow a timeout.
      expect(events.filter((e) => (e as { type: string }).type === "completed")).toEqual([]);
    },
  );

  it(
    "client abort before the deadline cancels without a timeout error",
    { timeout: 15000 },
    async () => {
      const client = new CommandCodeClient({
        secret: "s",
        timeoutMs: 10_000,
        fetchFn: (async () => {
          async function* streamChunks() {
            yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
            await new Promise<void>(() => undefined);
          }
          return { status: 200, text: async () => "", streamChunks };
        }) as never,
      });
      const adapter = new CommandCodeAdapter({ ackPath, client });
      const controller = new AbortController();
      const collected: unknown[] = [];
      const runPromise = (async () => {
        for await (const event of adapter.run(makeRequest(), controller.signal)) {
          collected.push(event);
          controller.abort();
        }
      })();
      await runPromise;
      expect(collected.filter((e) => (e as { type: string }).type === "error")).toEqual([]);
    },
  );

  it(
    "a successful long stream under the deadline passes",
    { timeout: 15000 },
    async () => {
      const client = new CommandCodeClient({
        secret: "s",
        timeoutMs: 10_000,
        fetchFn: (async () => {
          async function* streamChunks() {
            yield 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n';
          }
          return { status: 200, text: async () => "", streamChunks };
        }) as never,
      });
      const adapter = new CommandCodeAdapter({ ackPath, client });
      const events: unknown[] = [];
      for await (const event of adapter.run(makeRequest(), new AbortController().signal)) {
        events.push(event);
      }
      expect(events.filter((e) => (e as { type: string }).type === "completed").length).toBe(1);
    },
  );
});
