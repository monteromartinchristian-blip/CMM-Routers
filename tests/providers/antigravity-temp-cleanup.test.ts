import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  AntigravityAdapter,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function successRunner() {
  return {
    async streamInference(
      _args: string[],
      _options: { cwd: string; signal: AbortSignal },
      onEvent: (event: ParsedStreamEvent) => void,
    ) {
      onEvent({ kind: "completed", finishReason: "stop" });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
    async runInference(_args: string[], _options: { cwd: string; timeoutMs: number; signal: AbortSignal }) {
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

function makeRequest(): RouterRequest {
  return {
    requestId: "cleanup-001",
    model: {
      id: "google/some-model",
      provider: "google",
      upstreamModel: "some-model",
      displayName: "Some",
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    stream: true,
  };
}

describe("Antigravity temp cleanup", () => {
  it("removes its per-request temp directory after a successful run", async () => {
    const seen: string[] = [];
    const observing = {
      async streamInference(
        args: string[],
        options: { cwd: string; signal: AbortSignal },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        seen.push(options.cwd);
        return await successRunner().streamInference(args, options, onEvent);
      },
      async runInference(args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }) {
        return await successRunner().runInference(args, options);
      },
    };
    const adapter = new AntigravityAdapter(
      observing as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    for await (const _ of adapter.run(makeRequest(), new AbortController().signal)) {
      // consume
    }
    expect(seen.length).toBe(1);
    expect(existsSync(seen[0]!)).toBe(false);
  });
});
