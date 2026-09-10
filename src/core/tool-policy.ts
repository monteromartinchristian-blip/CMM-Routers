import { RouterError } from "./errors.js";
import type { ProviderId } from "./model.js";

/**
 * Provider tool-selection / parallel-execution policy.
 *
 * Rule: faithfully map the caller's constraint, or reject it explicitly.
 * A constraint must NEVER be accepted and then silently discarded — that makes
 * the Router's behaviour differ from the contract it advertises.
 *
 * One shared implementation is used by BOTH HTTP surfaces so
 * /v1/chat/completions and /v1/responses cannot diverge.
 */

export type NormalizedToolChoice =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "required" }
  | { kind: "named"; name: string };

/**
 * Validate the OpenAI tool_choice shape. Returns a RouterError for a shape the
 * Router cannot interpret at all (invalid_request), so downstream providers
 * only ever see one of the canonical forms.
 */
export function normalizeToolChoice(toolChoice: unknown): NormalizedToolChoice | RouterError {
  if (toolChoice === "auto") return { kind: "auto" };
  if (toolChoice === "none") return { kind: "none" };
  if (toolChoice === "required") return { kind: "required" };
  if (
    typeof toolChoice === "object" &&
    toolChoice !== null &&
    !Array.isArray(toolChoice) &&
    (toolChoice as { type?: unknown }).type === "function"
  ) {
    const fn = (toolChoice as { function?: unknown }).function;
    if (typeof fn === "object" && fn !== null && !Array.isArray(fn)) {
      const name = (fn as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        return { kind: "named", name };
      }
    }
    return new RouterError(
      "invalid_request",
      "tool_choice function form requires a non-empty function.name",
    );
  }
  return new RouterError(
    "invalid_request",
    "tool_choice must be 'auto', 'none', 'required', or a named function object",
  );
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
 */
export function enforceProviderToolPolicy(
  provider: ProviderId,
  toolChoice: unknown,
  parallelToolCalls: boolean | undefined,
): RouterError | null {
  const normalized =
    toolChoice === undefined ? undefined : normalizeToolChoice(toolChoice);
  if (normalized instanceof RouterError) return normalized;

  switch (provider) {
    // Codex 0.153.4 exposes no tool-selection or parallel-execution control on
    // its wire (verified against the generated experimental schema).
    case "chatgpt":
      if (normalized !== undefined && normalized.kind !== "auto") {
        return unsupported(provider, "tool_choice");
      }
      if (parallelToolCalls === false) {
        return unsupported(provider, "parallel_tool_calls=false");
      }
      return null;

    // Claude Agent SDK 0.3.266 Options expose allowedTools/disallowedTools/
    // permissionMode/canUseTool/hooks — no tool_choice and no
    // parallel_tool_calls anywhere. `auto` is the SDK's only behaviour, so it is
    // faithful; everything else is unrepresentable. Exactly one parked tool call
    // per session is enforced, so parallel_tool_calls=true is unrepresentable
    // while false/absent is precisely the enforced behaviour.
    case "claude":
      if (normalized !== undefined && normalized.kind !== "auto") {
        return unsupported(provider, "tool_choice");
      }
      if (parallelToolCalls === true) {
        return unsupported(provider, "parallel_tool_calls=true");
      }
      return null;

    // agy 1.2.0 exposes no tool-selection or parallel-execution flag (verified
    // against `agy --help`). Same rule as Claude.
    case "google":
      if (normalized !== undefined && normalized.kind !== "auto") {
        return unsupported(provider, "tool_choice");
      }
      if (parallelToolCalls === true) {
        return unsupported(provider, "parallel_tool_calls=true");
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
 * Exact OpenAI -> Anthropic Messages tool_choice mapping. Returns null when
 * there is nothing to send. Throws only for a shape that normalizeToolChoice
 * already accepted but Anthropic cannot express (none exists today, so this is
 * a guard rather than a routine path).
 */
export function toAnthropicToolChoice(
  toolChoice: unknown,
  parallelToolCalls: boolean | undefined,
): AnthropicToolChoice | null {
  const normalized =
    toolChoice === undefined ? undefined : normalizeToolChoice(toolChoice);
  if (normalized instanceof RouterError) throw normalized;
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
