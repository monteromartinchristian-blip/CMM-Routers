import type { NormalizedToolChoice } from "./tool-policy.js";

export type ProviderId =
  | "chatgpt"
  | "claude"
  | "google"
  | "command-code"
  | "cavoti";

export type ProviderCapability =
  | "CHAT_AND_TOOLS"
  | "CHAT_ONLY";

export interface DiscoveredModel {
  id: string;
  provider: ProviderId;
  upstreamModel: string;
  displayName: string;
  capability?: ProviderCapability;
  /**
   * The concrete version/family the upstream itself declares, when it declares
   * one.  `undefined` is an honest unknown — never a version inferred from the
   * id's spelling, because a rolling alias such as `sonnet` has no version to
   * infer and guessing one would be a fabricated product claim.
   */
  version?: string;
  /**
   * The serving vendor the upstream declares (an OpenAI-compatible listing's
   * `owned_by`).  Carried so a client names the real provider instead of
   * deriving one from the id.
   */
  vendor?: string;
  /**
   * Where this model's context actually goes.  A lane is a fact about egress,
   * never about the serving process being on loopback: a loopback proxy that
   * forwards to a hosted upstream is `remote`.
   */
  locality?: "local" | "cloud";
  /** Effort levels the upstream genuinely accepts, when it declares them. */
  reasoningEfforts?: readonly string[];
  /**
   * How this model was classified for the selector.  `available` is a working
   * route; `unavailable` is a retained identity that is not currently usable.
   */
  availability?: "available" | "unavailable";
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
  images?: string[];
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
