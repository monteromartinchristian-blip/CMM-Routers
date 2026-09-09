// Protocol types derived from installed codex app-server v0.147.0 schema
// Generated via: codex app-server generate-json-schema --out tests/fixtures/generated/codex

export interface JSONRPCRequest {
  jsonrpc?: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc?: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JSONRPCNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResponse {
  serverInfo?: {
    name: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface ThreadStartParams {
  model?: string;
  sandbox?: string;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

export interface TurnStartParams {
  threadId: string;
  input?: Array<{
    type: "text";
    text: string;
  }>;
}

export interface TurnStartResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface ModelListResponse {
  data: Array<{
    id: string;
    model?: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    isDefault?: boolean;
  }>;
  nextCursor?: string | null;
}

// Server notifications
export interface AgentMessageDeltaNotification {
  method: "item/agentMessage/delta";
  params: {
    threadId: string;
    turnId: string;
    delta: string;
  };
}

export interface TokenUsageUpdatedNotification {
  method: "thread/tokenUsage/updated";
  params: {
    threadId: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
  };
}

export interface TurnCompletedNotification {
  method: "turn/completed";
  params: {
    threadId: string;
    turnId: string;
    finishReason?: "stop" | "tool_calls" | "length" | "error";
  };
}

export interface CommandExecutionApprovalParams {
  method: "item/commandExecution/requestApproval";
  params: {
    threadId: string;
    turnId: string;
    command: string;
    args?: string[];
  };
}

export interface FileChangeApprovalParams {
  method: "item/fileChange/requestApproval";
  params: {
    threadId: string;
    turnId: string;
    path: string;
    change: string;
  };
}

export interface PermissionsApprovalParams {
  method: "item/permissions/requestApproval";
  params: {
    threadId: string;
    turnId: string;
    permission: string;
  };
}
