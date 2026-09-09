export type ProviderId =
  | "chatgpt"
  | "claude"
  | "google"
  | "command-code";

export type ProviderCapability =
  | "CHAT_AND_TOOLS"
  | "CHAT_ONLY";

export interface DiscoveredModel {
  id: string;
  provider: ProviderId;
  upstreamModel: string;
  displayName: string;
  capability?: ProviderCapability;
}

export interface RouterTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface RouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface RouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  name?: string;
  /**
   * Assistant tool-call history in OpenAI shape. Preserved end-to-end so a
   * provider that supplies real tool-call IDs never needs heuristic
   * reconstruction, and a provider that receives a follow-up turn can map
   * the same assistant tool calls back into its native protocol.
   */
  toolCalls?: RouterToolCall[];
}

export interface RouterRequest {
  requestId: string;
  model: DiscoveredModel;
  messages: RouterMessage[];
  tools: RouterTool[];
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
}
