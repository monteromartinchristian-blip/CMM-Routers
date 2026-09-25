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

class StreamingToolProvider implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  script: RouterEvent[] = [
    { type: "text_delta", text: "thinking" },
    { type: "tool_call_delta", index: 0, id: "call_a", name: "cmm_echo", argumentsDelta: '{"te' },
    { type: "tool_call_delta", index: 0, id: "call_a", name: "cmm_echo", argumentsDelta: 'xt":"canary"}' },
    { type: "completed", finishReason: "tool_calls" },
  ];

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/test-model",
        provider: "chatgpt",
        upstreamModel: "test-model",
        displayName: "Test Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    for (const event of this.script) yield event;
  }

  async cancel() {}
}

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    const payload = dataLine.slice("data: ".length);
    if (payload === "[DONE]") continue;
    out.push({ event: eventLine.slice("event: ".length), data: JSON.parse(payload) as Record<string, unknown> });
  }
  return out;
}

describe("Responses streaming function-call lifecycle", () => {
  let registry: ProviderRegistry;
  const bearerSecret = "test-secret-123";
  const qoderSecret = "qoder-secret-456";
  let provider: StreamingToolProvider;

  beforeEach(async () => {
    registry = new ProviderRegistry();
    provider = new StreamingToolProvider();
    await registry.register(provider);
    await registry.refresh();
  });

  it("emits the canonical item lifecycle with distinct ids and final arguments", async () => {
    const server = buildServer({ registry, bearerSecret, qoderToken: qoderSecret, usageStore: undefined as never, host: "127.0.0.1", port: 0 });
    const res = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${qoderSecret}`, "content-type": "application/json" },
      payload: { model: "chatgpt/test-model", input: "echo canary", stream: true, tools: [] },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const names = events.map((e) => e.event);

    const created = events.find((e) => e.event === "response.created")!.data;
    expect(created.type).toBe("response.created");
    const createdResponse = created.response as Record<string, unknown>;
    expect(createdResponse.object).toBe("response");
    expect(createdResponse.status).toBe("in_progress");
    expect(createdResponse.output).toEqual([]);

    expect(names).toContain("response.content_part.added");
    expect(names).toContain("response.output_text.done");
    expect(names).toContain("response.content_part.done");
    expect(names).toContain("response.output_item.added");
    expect(names).toContain("response.function_call_arguments.delta");
    expect(names).toContain("response.function_call_arguments.done");
    expect(names).toContain("response.output_item.done");
    expect(names).toContain("response.completed");

    const added = events.find(
      (e) =>
        e.event === "response.output_item.added" &&
        (e.data.item as Record<string, unknown>)?.type === "function_call",
    )!.data;
    const item = added.item as Record<string, unknown>;
    expect(item.type).toBe("function_call");
    expect(item.call_id).toBe("call_a");
    expect(item.id).not.toBe(item.call_id);
    expect(added.output_index).toBe(1); // text item occupies index 0
    console.log("RESPONSES_OUTPUT_ITEM_LIFECYCLE=PASS");
    console.log("RESPONSES_CALL_ID_DISTINCT_FROM_ITEM_ID=PASS");

    // Arguments are buffered until the call completes and validated before any
    // fragment is surfaced, so the delta carries the whole usable payload rather
    // than an unchecked fragment.
    const delta = events.find((e) => e.event === "response.function_call_arguments.delta")!.data;
    expect(delta.item_id).toBe(item.id);
    expect(delta.delta).toBe('{"text":"canary"}');
    expect(() => JSON.parse(delta.delta as string)).not.toThrow();
    console.log("RESPONSES_FUNCTION_CALL_ARGUMENTS_DELTA=PASS");
    console.log("RESPONSES_STREAM_ARGUMENTS_VALIDATED_BEFORE_SURFACING=PASS");

    const done = events.find((e) => e.event === "response.function_call_arguments.done")!.data;
    expect(done.arguments).toBe('{"text":"canary"}');
    expect(done.output_index).toBe(1);
    console.log("RESPONSES_FUNCTION_CALL_ARGUMENTS_DONE=PASS");

    const itemDone = events.find(
      (e) =>
        e.event === "response.output_item.done" &&
        (e.data.item as Record<string, unknown>)?.type === "function_call",
    )!.data;
    expect((itemDone.item as Record<string, unknown>).arguments).toBe('{"text":"canary"}');

    // Ordering: function-call arguments.done must precede the function-call
    // output_item.done. A completed message item may legitimately appear first.
    const idx = (name: string) => names.indexOf(name);
    const functionCallItemDoneIndex = events.findIndex(
      (e) =>
        e.event === "response.output_item.done" &&
        (e.data.item as Record<string, unknown>)?.type === "function_call",
    );
    expect(functionCallItemDoneIndex).toBeGreaterThanOrEqual(0);
    expect(idx("response.function_call_arguments.done")).toBeLessThan(functionCallItemDoneIndex);
    expect(functionCallItemDoneIndex).toBeLessThan(idx("response.completed"));

    // Text streaming must not regress.
    const textAdded = events.find(
      (e) =>
        e.event === "response.output_item.added" &&
        (e.data.item as Record<string, unknown>)?.type === "message",
    );
    expect(textAdded).toBeDefined();
    expect((textAdded!.data.item as Record<string, unknown>).status).toBe("in_progress");

    const textDelta = events.find((e) => e.event === "response.output_text.delta");
    expect(textDelta).toBeDefined();
    expect(textDelta!.data.type).toBe("response.output_text.delta");
    expect(textDelta!.data.delta).toBe("thinking");
    expect(textDelta!.data.item_id).toBe("msg-0");
    expect(textDelta!.data.output_index).toBe(0);
    expect(textDelta!.data.content_index).toBe(0);

    const firstMessageAddedIndex = events.findIndex(
      (e) =>
        e.event === "response.output_item.added" &&
        (e.data.item as Record<string, unknown>)?.type === "message",
    );
    expect(firstMessageAddedIndex).toBeGreaterThanOrEqual(0);
    expect(firstMessageAddedIndex).toBeLessThan(idx("response.output_text.delta"));

    const completed = events.find((e) => e.event === "response.completed")!.data;
    expect(completed.type).toBe("response.completed");
    const completedResponse = completed.response as Record<string, unknown>;
    expect(completedResponse.object).toBe("response");
    expect(completedResponse.status).toBe("completed");
    const completedOutput = completedResponse.output as Array<Record<string, unknown>>;
    expect(completedOutput.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect((completedOutput[0]!.content as Array<Record<string, unknown>>)[0]!.text).toBe("thinking");
    expect(completedOutput[1]).toMatchObject({
      type: "function_call",
      call_id: "call_a",
      name: "cmm_echo",
      arguments: '{"text":"canary"}',
      status: "completed",
    });

    console.log("RESPONSES_CODEX_0147_CANONICAL_ENVELOPE=PASS");
    console.log("RESPONSES_TEXT_ITEM_LIFECYCLE=PASS");
    console.log("RESPONSES_COMPLETED_OUTPUT_SNAPSHOT=PASS");
  });
});
