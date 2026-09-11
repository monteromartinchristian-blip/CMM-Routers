import { RouterError } from "./errors.js";
import type { ProviderId } from "./model.js";

/**
 * Provider tool-selection / parallel-execution policy.
 *
 * Rule: faithfully map the caller's constraint, or reject it explicitly.
 * A constraint must NEVER be accepted and then silently discarded — that makes
 * the Router's behaviour differ from the contract it advertises.
 *
 * The flow is deliberately two-stage:
 *   1. Each public HTTP surface parses ITS OWN wire shape into the internal
 *      NormalizedToolChoice (parseChatToolChoice / parseResponsesToolChoice).
 *   2. Provider policy consumes ONLY that internal form, so it neither knows
 *      nor depends on which public API the request arrived on. One shared
 *      implementation therefore covers both /v1/chat/completions and
 *      /v1/responses without them being able to diverge.
 */

export type NormalizedToolChoice =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "required" }
  | { kind: "named"; name: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_CHOICE_SHAPE_HELP =
  "tool_choice must be 'auto', 'none', 'required', or a named function object";

/** The three string forms are identical on both OpenAI surfaces. */
function parseStringToolChoice(raw: unknown): NormalizedToolChoice | null {
  if (raw === "auto") return { kind: "auto" };
  if (raw === "none") return { kind: "none" };
  if (raw === "required") return { kind: "required" };
  return null;
}

/**
 * Chat Completions wire: a named function choice is NESTED
 * `{type:"function", function:{name}}`. The Responses FLAT shape is not a
 * valid Chat Completions shape and is rejected as invalid_request. Returns
 * undefined when the field is absent.
 */
export function parseChatToolChoice(
  raw: unknown,
): NormalizedToolChoice | RouterError | undefined {
  if (raw === undefined) return undefined;
  const stringChoice = parseStringToolChoice(raw);
  if (stringChoice !== null) return stringChoice;
  if (isRecord(raw) && raw.type === "function") {
    const fn = raw.function;
    if (isRecord(fn) && typeof fn.name === "string" && fn.name.length > 0) {
      return { kind: "named", name: fn.name };
    }
    return new RouterError(
      "invalid_request",
      "tool_choice function form requires a non-empty function.name",
    );
  }
  return new RouterError("invalid_request", TOOL_CHOICE_SHAPE_HELP);
}

/**
 * Responses wire: a named function choice is FLAT `{type:"function", name}`.
 * The Chat Completions nested shape is not a valid Responses shape, and the
 * Responses object forms for hosted tools (e.g. {type:"web_search_preview"})
 * are not function choices — both are rejected as invalid_request. Returns
 * undefined when the field is absent.
 */
export function parseResponsesToolChoice(
  raw: unknown,
): NormalizedToolChoice | RouterError | undefined {
  if (raw === undefined) return undefined;
  const stringChoice = parseStringToolChoice(raw);
  if (stringChoice !== null) return stringChoice;
  if (isRecord(raw) && raw.type === "function") {
    if (typeof raw.name === "string" && raw.name.length > 0) {
      return { kind: "named", name: raw.name };
    }
    return new RouterError(
      "invalid_request",
      "tool_choice function form requires a non-empty name",
    );
  }
  return new RouterError("invalid_request", TOOL_CHOICE_SHAPE_HELP);
}

/**
 * True only for the Router's internal representation. Raw public wire shapes
 * (Chat nested / Responses flat) are NOT normalized forms and fail this guard,
 * which lets the provider-boundary mappers refuse them instead of reparsing.
 */
export function isNormalizedToolChoice(value: unknown): value is NormalizedToolChoice {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "auto":
    case "none":
    case "required":
      return true;
    case "named":
      return typeof value.name === "string" && value.name.length > 0;
    default:
      return false;
  }
}

/**
 * Serialize the internal policy back into the Chat Completions wire shape.
 * Used by providers whose upstream wire is OpenAI-compatible, so the body they
 * emit is byte-identical to what the caller sent on the Chat surface.
 */
export function toChatWireToolChoice(
  policy: NormalizedToolChoice | undefined,
): string | { type: "function"; function: { name: string } } | undefined {
  if (policy === undefined) return undefined;
  if (policy.kind === "named") return { type: "function", function: { name: policy.name } };
  return policy.kind;
}

function unsupported(provider: ProviderId, what: string): RouterError {
  return new RouterError(
    "unsupported_capability",
    `${provider} cannot represent the requested ${what}; refusing to drop it silently`,
  );
}

/**
 * Returns null when the request's policy is representable for `provider`, or a
 * RouterError that must be returned to the caller BEFORE provider invocation.
 *
 * `policy` is ALWAYS the internal normalized form produced by the
 * surface-specific parser — never a raw public wire shape.
 */
export function enforceProviderToolPolicy(
  provider: ProviderId,
  policy: NormalizedToolChoice | undefined,
  parallelToolCalls: boolean | undefined,
): RouterError | null {
  switch (provider) {
    // Codex 0.153.4 exposes no tool-selection or parallel-execution control on
    // its wire (verified against the generated experimental schema).
    case "chatgpt":
      if (policy !== undefined && policy.kind !== "auto") {
        return unsupported(provider, "tool_choice");
      }
      if (parallelToolCalls === false) {
        return unsupported(provider, "parallel_tool_calls=false");
      }
      return null;

    // Claude Agent SDK 0.3.266 Options expose allowedTools/disallowedTools/
    // permissionMode/canUseTool/hooks — no tool_choice and no
    // parallel_tool_calls anywhere (verified against the SDK Options type).
    // `auto`/absent is the SDK's only tool-selection behaviour, so it is
    // faithful; every other kind is unrepresentable. For parallel execution
    // NEITHER true NOR false has a proven provider-side representation: the
    // Router's own one-parked-call-per-session rule is a Router safety limit,
    // not an upstream statement that parallel calls are disabled, so accepting
    // an explicit false here would silently approximate the caller's
    // constraint. Absence is faithful; any explicit boolean is refused.
    //
    // agy 1.2.0 exposes no tool-selection or parallel-execution flag
    // (verified against `agy --help`) — same literal rule as Claude.
    case "claude":
    case "google":
      if (policy !== undefined && policy.kind !== "auto") {
        return unsupported(provider, "tool_choice");
      }
      if (parallelToolCalls !== undefined) {
        return unsupported(provider, `parallel_tool_calls=${parallelToolCalls}`);
      }
      return null;

    // Command Code: the OpenAI wire forwards both fields verbatim; the
    // Anthropic Messages wire maps every canonical shape exactly
    // (auto/none/any/tool + disable_parallel_tool_use), so nothing is dropped.
    case "command-code":
      return null;
  }
}

/** Anthropic Messages tool_choice shape produced by the exact mapping. */
export interface AnthropicToolChoice {
  type: "auto" | "none" | "any" | "tool";
  name?: string;
  disable_parallel_tool_use?: boolean;
}

/**
 * Exact OpenAI -> Anthropic Messages tool_choice mapping. Consumes ONLY the
 * Router's internal normalized policy: a raw public wire shape (Chat nested or
 * Responses flat) is refused here rather than reparsed, so the Anthropic wire
 * cannot diverge from the decision each HTTP surface already made. Returns
 * null when there is nothing to send.
 */
export function toAnthropicToolChoice(
  policy: unknown,
  parallelToolCalls: boolean | undefined,
): AnthropicToolChoice | null {
  if (policy !== undefined && !isNormalizedToolChoice(policy)) {
    throw new RouterError(
      "invalid_request",
      "toAnthropicToolChoice requires the Router's normalized tool policy",
    );
  }
  const normalized = policy as NormalizedToolChoice | undefined;
  if (normalized === undefined && parallelToolCalls === undefined) return null;

  let choice: AnthropicToolChoice;
  if (normalized === undefined) {
    // Anthropic's default is already "auto"; only the parallel flag needs a body.
    choice = { type: "auto" };
  } else if (normalized.kind === "auto") {
    choice = { type: "auto" };
  } else if (normalized.kind === "none") {
    choice = { type: "none" };
  } else if (normalized.kind === "required") {
    choice = { type: "any" };
  } else {
    choice = { type: "tool", name: normalized.name };
  }

  // parallel_tool_calls=true is Anthropic's default (parallel allowed) and is
  // expressed by omitting the flag entirely.
  if (parallelToolCalls === false) {
    choice.disable_parallel_tool_use = true;
  }
  return choice;
}
