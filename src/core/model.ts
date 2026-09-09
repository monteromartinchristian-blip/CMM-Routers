export type ProviderId =
  | "chatgpt"
  | "claude"
  | "google"
  | "command-code";

export type ProviderCapability = 
  | "CHAT_AND_TOOLS"
  | "CHAT_ONLY"
  | "CHAT_ONLY_PENDING_TASK_13";

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

export interface RouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  name?: string;
}

export interface RouterRequest {
  requestId: string;
  model: DiscoveredModel;
  messages: RouterMessage[];
  tools: RouterTool[];
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}
