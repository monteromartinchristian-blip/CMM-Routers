import { afterEach, describe, expect, it } from "vitest";
import {
  CommandCodeClient,
  MAX_PROVIDER_SSE_FRAME_BYTES,
} from "../../src/providers/command-code/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Command Code upstream SSE frame bound", () => {
  it("fails closed when an unterminated SSE frame exceeds the bound", async () => {
    // Drive the REAL default fetch wrapper (which owns the SSE carry buffer)
    // with a response body that never emits the "\n\n" frame delimiter.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(MAX_PROVIDER_SSE_FRAME_BYTES + 4096)));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const client = new CommandCodeClient({ secret: "canary-secret" });
    let caught: unknown;
    try {
      for await (const _chunk of client.streamChatCompletion(
        "test-model",
        [],
        new AbortController().signal,
        {},
      )) {
        // No complete frames are expected from an unterminated buffer.
      }
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("provider_protocol_error");
    console.log("COMMAND_CODE_SSE_FRAME_BOUND=PASS");
    console.log("COMMAND_CODE_OVERSIZE_SSE_FRAME_FAIL_CLOSED=PASS");
  }, 30000);
});
