import { RouterError } from "../../core/errors.js";
import type { RouterTool } from "../../core/model.js";
import type {
  SchemaAgentMessageDeltaParams,
  SchemaDynamicFunctionToolSpec,
  SchemaDynamicToolSpec,
  SchemaThreadStartParams,
  SchemaTokenUsageUpdatedParams,
  SchemaTurn,
  SchemaTurnCompletedParams,
  SchemaTurnInterruptParams,
  SchemaTurnStartResponse,
} from "./schema-protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RouterError(
      "provider_protocol_error",
      `Codex schema violation: ${context} missing required string "${key}"`,
    );
  }
  return value;
}

/** Parse turn/start result per generated TurnStartResponse: { turn: { id, ... } }. */
export function parseTurnStartResponse(result: unknown): { turnId: string; turn: SchemaTurn } {
  if (!isRecord(result)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: turn/start result is not an object");
  }
  const turn = result.turn;
  if (!isRecord(turn)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: turn/start result.turn missing");
  }
  const turnId = requiredString(turn, "id", "turn/start result.turn");
  return {
    turnId,
    turn: {
      id: turnId,
      status: typeof turn.status === "string" ? (turn.status as SchemaTurn["status"]) : "inProgress",
      items: Array.isArray(turn.items) ? turn.items : [],
      ...(isRecord(turn.error) ? { error: { message: String((turn.error as Record<string, unknown>).message ?? "") } } : {}),
    },
  };
}

/** Parse thread/tokenUsage/updated params per generated schema (nested tokenUsage). */
export function parseTokenUsageParams(params: unknown): {
  threadId: string;
  turnId: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
} {
  if (!isRecord(params)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: tokenUsage params not an object");
  }
  const threadId = requiredString(params, "threadId", "tokenUsage");
  const turnId = requiredString(params, "turnId", "tokenUsage");
  const tokenUsage = params.tokenUsage;
  if (!isRecord(tokenUsage)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: tokenUsage.tokenUsage missing");
  }
  // Prefer the per-turn "last" breakdown; fall back to "total".
  const breakdown = (isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage.total) as
    | Record<string, unknown>
    | undefined;
  if (!breakdown || !isRecord(breakdown)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: tokenUsage breakdown missing");
  }
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    threadId,
    turnId,
    ...(num(breakdown.inputTokens) !== undefined ? { inputTokens: num(breakdown.inputTokens)! } : {}),
    ...(num(breakdown.outputTokens) !== undefined ? { outputTokens: num(breakdown.outputTokens)! } : {}),
    ...(num(breakdown.reasoningOutputTokens) !== undefined
      ? { reasoningTokens: num(breakdown.reasoningOutputTokens)! }
      : {}),
    ...(num(breakdown.cachedInputTokens) !== undefined
      ? { cacheReadTokens: num(breakdown.cachedInputTokens)! }
      : {}),
  };
}

/** Parse item/agentMessage/delta params per generated schema. */
export function parseAgentDeltaParams(params: unknown): SchemaAgentMessageDeltaParams {
  if (!isRecord(params)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: agent delta params not an object");
  }
  return {
    delta: requiredString(params, "delta", "agentMessage/delta"),
    itemId: requiredString(params, "itemId", "agentMessage/delta"),
    threadId: requiredString(params, "threadId", "agentMessage/delta"),
    turnId: requiredString(params, "turnId", "agentMessage/delta"),
  };
}

/** Parse turn/completed params per generated schema: { threadId, turn }. */
export function parseTurnCompletedParams(params: unknown): {
  threadId: string;
  turnId: string;
  status: string;
  errorMessage?: string;
} {
  if (!isRecord(params)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: turn/completed params not an object");
  }
  const threadId = requiredString(params, "threadId", "turn/completed");
  const turn = params.turn;
  if (!isRecord(turn)) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: turn/completed turn missing");
  }
  const turnId = requiredString(turn, "id", "turn/completed turn");
  const status = typeof turn.status === "string" ? turn.status : "completed";
  const error = turn.error;
  const errorMessage =
    isRecord(error) && typeof error.message === "string" ? error.message : undefined;
  return { threadId, turnId, status, ...(errorMessage ? { errorMessage } : {}) };
}

/**
 * Map Qoder/OpenAI function tools onto the Codex 0.153.4 experimental
 * `DynamicToolSpec` function variant. Field names/shape come from the tracked
 * experimental fixture (see tests/fixtures/generated/codex-experimental-0.153.4).
 *
 * A tool with an empty name is a protocol violation: refuse rather than emit an
 * undeclarable spec.
 */
export function toDynamicToolSpecs(
  tools: RouterTool[],
): SchemaDynamicFunctionToolSpec[] {
  return tools.map((tool) => {
    const name = tool.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new RouterError(
        "provider_protocol_error",
        "Codex dynamic tool declaration requires a non-empty function name",
      );
    }
    return {
      type: "function" as const,
      name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? {},
      deferLoading: false,
    };
  });
}

/** Build thread/start params with explicit ephemeral + developer instructions. */
export function buildThreadStartParams(input: {
  model?: string;
  sandbox?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  dynamicTools?: SchemaDynamicToolSpec[];
}): SchemaThreadStartParams {
  return {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
    ...(input.developerInstructions !== undefined
      ? { developerInstructions: input.developerInstructions }
      : {}),
    ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
    ...(input.dynamicTools !== undefined ? { dynamicTools: input.dynamicTools } : {}),
  };
}

/** Validate interrupt params before sending: never emit an empty turn id. */
export function buildTurnInterruptParams(input: {
  threadId: unknown;
  turnId: unknown;
}): SchemaTurnInterruptParams {
  if (typeof input.threadId !== "string" || input.threadId.length === 0) {
    throw new RouterError("provider_protocol_error", "Codex schema violation: interrupt missing threadId");
  }
  if (typeof input.turnId !== "string" || input.turnId.length === 0) {
    throw new RouterError(
      "provider_protocol_error",
      "Codex refuses empty turn interrupt: turnId missing (cancellation not sent)",
    );
  }
  return { threadId: input.threadId, turnId: input.turnId };
}

export type {
  SchemaTokenUsageUpdatedParams,
  SchemaTurnCompletedParams,
  SchemaTurnStartResponse,
};
