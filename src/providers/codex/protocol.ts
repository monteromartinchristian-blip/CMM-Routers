// Protocol types derived from installed codex app-server v0.147.0 schema
// Generated via: codex app-server generate-json-schema --out tests/fixtures/generated/codex
//
// JSON-RPC envelope plumbing only. Method PAYLOADS (turn results, token
// usage, deltas, thread params) are defined in ./schema-protocol.ts, which
// mirrors the TRACKED GENERATED v2 artifacts field-for-field:
//   TurnStartResponse      -> { turn: Turn },       Turn requires id/items/status
//   TokenUsage notification-> { threadId, turnId, tokenUsage }
//   AgentMessage delta     -> { delta, itemId, threadId, turnId }
//   TurnCompleted          -> { threadId, turn }
//   TurnInterruptParams    -> { threadId, turnId }
//   ThreadStartParams      -> { ..., developerInstructions?, ephemeral? }
//   ThreadInjectItemsParams-> { threadId, items }
// Hand-written payload shapes below are DEPRECATED: they predate the
// generated schema and are retained only so older imports keep compiling.
// New code must use the schema-backed layer (see ./schema-translator.ts).

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

/** @deprecated Use SchemaThreadStartParams (schema-protocol.ts). */
export interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

export interface TurnStartParams {
  threadId: string;
  input?: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "image";
        url: string;
      }
  >;
  /**
   * Schema-backed per-turn reasoning-effort override. The field is omitted
   * entirely when the caller asked for no level, so the provider default stays
   * provider-owned.
   */
  effort?: string;
}

/**
 * @deprecated Stale shape. The generated schema returns
 * `{ turn: { id, status, items } }` — parse via parseTurnStartResponse().
 */
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

/**
 * @deprecated Stale shape. The generated schema nests counts under
 * `params.tokenUsage.{last,total}` — parse via parseTokenUsageParams().
 */
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

/**
 * @deprecated Stale shape. The generated schema sends
 * `params: { threadId, turn }` — parse via parseTurnCompletedParams().
 */
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
