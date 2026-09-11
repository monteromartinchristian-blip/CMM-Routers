export type RouterEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
    }
  | { type: "completed"; finishReason: "stop" | "tool_calls" | "length" }
  | { type: "error"; error: unknown };
