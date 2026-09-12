import { describe, expect, it } from "vitest";

import { feedStreamLine } from "../../src/providers/antigravity/adapter.js";

type ParsedEvent = {
  kind?: string;
  texts?: string[];
  finishReason?: string;
};

type StreamState = {
  sawText: boolean;
};

// The current production API has two parameters. Casting keeps the RED test
// behavioral rather than turning the expected failure into a TypeScript arity
// error; the third state argument is intentionally ignored until the fix.
const feedWithState = feedStreamLine as unknown as (
  line: string,
  emit: (event: ParsedEvent) => void,
  state: StreamState,
) => { terminal: boolean };

function textFrom(events: ParsedEvent[]): string {
  return events
    .filter((event) => event.kind === "text")
    .flatMap((event) => event.texts ?? [])
    .join("");
}

describe("Antigravity terminal result.response fallback", () => {
  it("does not re-emit result.response after incremental text was already streamed", () => {
    const events: ParsedEvent[] = [];
    const state: StreamState = { sawText: false };
    const emit = (event: ParsedEvent) => events.push(event);

    const first = feedWithState(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          text_delta: "DELTA_ONCE",
        },
      }),
      emit,
      state,
    );

    const second = feedWithState(
      JSON.stringify({
        event: "result",
        result: {
          status: "ok",
          response: "DELTA_ONCE\n",
        },
      }),
      emit,
      state,
    );

    expect(first.terminal).toBe(false);
    expect(second.terminal).toBe(true);
    expect(textFrom(events)).toBe("DELTA_ONCE");
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(1);
  });

  it("still emits result.response when no incremental text was streamed", () => {
    const events: ParsedEvent[] = [];
    const state: StreamState = { sawText: false };

    feedWithState(
      JSON.stringify({
        event: "result",
        result: {
          status: "ok",
          response: "RESULT_ONLY\n",
        },
      }),
      (event) => events.push(event),
      state,
    );

    expect(textFrom(events)).toBe("RESULT_ONLY\n");
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(1);
  });
});
