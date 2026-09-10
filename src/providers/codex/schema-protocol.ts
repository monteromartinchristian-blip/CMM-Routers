// Schema-backed Codex app-server protocol types.
//
// Source of truth: tests/fixtures/generated/codex/v2/*.json (generated via
// `codex app-server generate-json-schema`). Field names and nesting below
// mirror the TRACKED GENERATED ARTIFACTS, not memory:
//
// - TurnStartResponse: { turn: Turn }, Turn requires id/items/status
// - ThreadTokenUsageUpdatedNotification: { threadId, turnId, tokenUsage }
// - AgentMessageDeltaNotification: { delta, itemId, threadId, turnId }
// - TurnCompletedNotification: { threadId, turn }
// - TurnInterruptParams: { threadId, turnId }
// - ThreadStartParams: { developerInstructions?, ephemeral?, ... }
// - ThreadInjectItemsParams: { threadId, items }
// - UserInput: oneOf TextUserInput | ImageUserInput | ...
//
// The legacy loose hand-written protocol.ts is kept for JSON-RPC envelope
// plumbing only; request/response/notification PAYLOADS must use these
// schema-backed shapes (see ./schema-translator.ts).

export interface SchemaTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items: unknown[];
  error?: { message: string } | null;
}

export interface SchemaTurnStartResponse {
  turn: SchemaTurn;
}

export interface SchemaTokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheWriteInputTokens?: number;
}

export interface SchemaThreadTokenUsage {
  last: SchemaTokenUsageBreakdown;
  total: SchemaTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface SchemaTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: SchemaThreadTokenUsage;
}

export interface SchemaAgentMessageDeltaParams {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface SchemaTurnCompletedParams {
  threadId: string;
  turn: SchemaTurn;
}

export interface SchemaTurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * Experimental Codex 0.153.4 dynamic tool declaration, mirroring the generated
 * `DynamicToolSpec` oneOf (only the `function` variant is used by the Router;
 * the `namespace` variant is declared for completeness).
 *
 *   codex app-server generate-json-schema --experimental --out DIR
 *
 * `thread/start.dynamicTools` is experimental and requires
 * `initialize.params.capabilities.experimentalApi = true`.
 */
export interface SchemaDynamicFunctionToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface SchemaDynamicNamespaceToolSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: unknown[];
}

export type SchemaDynamicToolSpec =
  | SchemaDynamicFunctionToolSpec
  | SchemaDynamicNamespaceToolSpec;

export interface SchemaThreadStartParams {
  model?: string | null;
  sandbox?: string | null;
  developerInstructions?: string | null;
  baseInstructions?: string | null;
  ephemeral?: boolean | null;
  cwd?: string | null;
  /** Experimental (0.153.4): requires capabilities.experimentalApi at initialize. */
  dynamicTools?: SchemaDynamicToolSpec[] | null;
}

export interface SchemaThreadInjectItemsParams {
  threadId: string;
  // Raw Responses API items appended to model-visible history.
  items: unknown[];
}

export interface SchemaTextUserInput {
  type: "text";
  text: string;
}
