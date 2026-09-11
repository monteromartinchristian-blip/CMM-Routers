import { describe, expect, it } from "vitest";
import {
  AntigravityAdapter,
  feedStreamLine,
  serializeConversationForHeadlessPrompt,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

function conversationMessages() {
  return [
    { role: "system", content: "SYSTEM_MARKER_ABC" },
    { role: "user", content: "USER_ONE_ABC" },
    { role: "assistant", content: "ASSISTANT_HISTORY_ABC" },
    { role: "user", content: "USER_TWO_ABC" },
  ] as RouterRequest["messages"];
}

function makeRequest(): RouterRequest {
  return {
    requestId: "agy-ctx-001",
    model: {
      id: "google/some-model",
      provider: "google",
      upstreamModel: "some-model",
      displayName: "Some",
      capability: "CHAT_ONLY",
    },
    messages: conversationMessages(),
    tools: [],
    stream: true,
  };
}

describe("Antigravity conversation preservation", () => {
  it("serializes system, users, and assistant history in order", () => {
    const prompt = serializeConversationForHeadlessPrompt(conversationMessages());
    for (const marker of [
      "SYSTEM_MARKER_ABC",
      "USER_ONE_ABC",
      "ASSISTANT_HISTORY_ABC",
      "USER_TWO_ABC",
    ]) {
      expect(prompt).toContain(marker);
    }
    console.log("ANTIGRAVITY_SYSTEM_PRESERVED=YES");
    console.log("ANTIGRAVITY_USER_HISTORY_PRESERVED=YES");
    console.log("ANTIGRAVITY_ASSISTANT_HISTORY_PRESERVED=YES");
    const order = [
      prompt.indexOf("SYSTEM_MARKER_ABC"),
      prompt.indexOf("USER_ONE_ABC"),
      prompt.indexOf("ASSISTANT_HISTORY_ABC"),
      prompt.indexOf("USER_TWO_ABC"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    console.log("ANTIGRAVITY_MESSAGE_ORDER_PRESERVED=YES");
  });

  it("passes the actual spawned agy prompt with full semantics", async () => {
    let observedPrompt = "";
    const runner = {
      async streamInference(
        args: string[],
        _options: { cwd: string; signal: AbortSignal },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        const printIndex = args.indexOf("--print");
        observedPrompt = String(args[printIndex + 1] ?? "");
        feedStreamLine(
          JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
          onEvent,
        );
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const adapter = new AntigravityAdapter(
      runner as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    for await (const _ of adapter.run(makeRequest(), new AbortController().signal)) {
      // consume
    }
    for (const marker of [
      "SYSTEM_MARKER_ABC",
      "USER_ONE_ABC",
      "ASSISTANT_HISTORY_ABC",
      "USER_TWO_ABC",
    ]) {
      expect(observedPrompt).toContain(marker);
    }
    const order = [
      observedPrompt.indexOf("SYSTEM_MARKER_ABC"),
      observedPrompt.indexOf("USER_ONE_ABC"),
      observedPrompt.indexOf("ASSISTANT_HISTORY_ABC"),
      observedPrompt.indexOf("USER_TWO_ABC"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No repository context injected, no unsafe flags.
    expect(observedPrompt).not.toContain("--dangerously-skip-permissions");
  });
});
