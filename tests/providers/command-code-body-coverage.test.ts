import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
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

describe("Command Code discovery and error body deadlines", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-bodies-"));
    ackPath = validAck(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "times out a /models body that stalls after headers",
    { timeout: 15000 },
    async () => {
      const client = new CommandCodeClient({
        secret: "s",
        timeoutMs: 200,
        fetchFn: (async () => ({
          status: 200,
          text: async () => {
            await new Promise<void>(() => undefined);
            return "";
          },
        })) as never,
      });
      const adapter = new CommandCodeAdapter({ ackPath, client });
      await expect(adapter.discoverModels()).rejects.toMatchObject({
        code: "provider_timeout",
      });
      console.log("COMMAND_CODE_MODELS_BODY_TIMEOUT=PASS");
    },
  );

  it(
    "times out a stalled non-200 error body instead of hanging",
    { timeout: 15000 },
    async () => {
      for (const status of [400, 401, 429, 500]) {
        const client = new CommandCodeClient({
          secret: "s",
          timeoutMs: 200,
          fetchFn: (async () => ({
            status,
            text: async () => {
              await new Promise<void>(() => undefined);
              return "";
            },
          })) as never,
        });
        const adapter = new CommandCodeAdapter({ ackPath, client });
        const events: unknown[] = [];
        for await (const event of adapter.run(
          {
            requestId: `cc-err-${status}`,
            model: {
              id: "command-code/goat-model-a",
              provider: "command-code",
              upstreamModel: "goat-model-a",
              displayName: "goat-model-a",
              capability: "CHAT_ONLY",
            },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: true,
          },
          new AbortController().signal,
        )) {
          events.push(event);
        }
        const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
          | { error: RouterError }
          | undefined;
        expect(errorEvent?.error.code).toBe("provider_timeout");
      }
      console.log("COMMAND_CODE_ERROR_BODY_TIMEOUT=PASS");
    },
  );

  it("still maps a completed error body to its specific error", async () => {
    const client = new CommandCodeClient({
      secret: "s",
      timeoutMs: 10_000,
      fetchFn: (async () => ({
        status: 403,
        text: async () => "MODEL_NOT_IN_PLAN: not included",
      })) as never,
    });
    const adapter = new CommandCodeAdapter({ ackPath, client });
    const events: unknown[] = [];
    for await (const event of adapter.run(
      {
        requestId: "cc-err-mapped",
        model: {
          id: "command-code/goat-model-a",
          provider: "command-code",
          upstreamModel: "goat-model-a",
          displayName: "goat-model-a",
          capability: "CHAT_ONLY",
        },
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        stream: true,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_quota_exhausted");
  });
});
