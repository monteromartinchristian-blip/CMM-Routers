import type { NormalizedToolChoice } from "./tool-policy.js";

export type ProviderId =
  | "chatgpt"
  | "claude"
  | "google"
  | "command-code"
  | "cavoti";

/**
 * Runtime mirror of ProviderId. Single source of truth for wire validation so a
 * newly added provider cannot silently drift out of an enumeration list.
 */
export const PROVIDER_IDS = [
  "chatgpt",
  "claude",
  "google",
  "command-code",
  "cavoti",
] as const satisfies readonly ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

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

/**
 * Canonical reasoning-effort vocabulary shared by the [OI]-compatible surfaces.
 * Adapters forward only the subset their runtime actually accepts.
 */
export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * A client-owned function tool. This is the ONLY executable declaration class:
 * the client/harness executes it and the Router only relays intent and result.
 */
export interface RouterFunctionTool {
  kind: "function";
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A grouped/namespaced declaration. Representable so the Router can classify and
 * refuse it precisely; not executable unless a generic, reversible,
 * collision-safe implementation is added.
 */
export interface RouterNamespaceTool {
  kind: "namespace";
  type: "namespace";
  namespace: { name: string; raw: Record<string, unknown> };
}

/**
 * A provider-hosted tool. Representable so it can be refused by name: execution
 * is client-owned, so provider-side tools stay explicitly unsupported.
 */
export interface RouterHostedTool {
  kind: "hosted";
  type: string;
  hosted: { type: string; raw: Record<string, unknown> };
}

/**
 * Any declaration class the Router does not recognize. Representable only so it
 * can be refused without guessing.
 */
export interface RouterUnknownTool {
  kind: "unknown";
  type: string;
  unknown: { type: string; raw: Record<string, unknown> };
}

/**
 * The canonical tool DECLARATION algebra, discriminated by capability class.
 *
 * Representable is not executable and not allowed: policy decides which classes
 * may proceed, and `RouterRequest.tools` narrows to the executable subset so a
 * provider adapter can never be handed a class it does not support.
 */
export type RouterTool =
  | RouterFunctionTool
  | RouterNamespaceTool
  | RouterHostedTool
  | RouterUnknownTool;

/** Narrow a declaration to the only executable class. */
export function isFunctionTool(tool: RouterTool): tool is RouterFunctionTool {
  return tool.kind === "function";
}

export interface RouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Outcome of a client-executed tool result. Generic and vendor-neutral; an
 * absent value means the protocol carried no explicit outcome.
 */
export type RouterToolResultStatus = "success" | "error";

export interface RouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  images?: string[];
  toolCallId?: string;
  name?: string;
  /**
   * Canonical outcome of a client-executed tool result. Preserved so a failed
   * tool never becomes indistinguishable from a successful one downstream.
   */
  toolResultStatus?: RouterToolResultStatus;
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
  tools: RouterFunctionTool[];
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * Internal, API-independent tool policy produced by the surface-specific
   * wire parsers (parseChatToolChoice / parseResponsesToolChoice). It is NEVER
   * the raw public wire shape, so provider adapters must not expect
   * `{type:"function", ...}` here.
   */
  toolChoice?: NormalizedToolChoice;
  parallelToolCalls?: boolean;
}
