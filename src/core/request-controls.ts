/**
 * Downstream request-control truth.
 *
 * A capability descriptor is only useful if it matches what the surfaces
 * actually do. These lists are therefore the SINGLE source of truth: the HTTP
 * surfaces enforce them, and `x_cmm.request_controls` is derived from them, so
 * publication and behavior cannot drift apart.
 *
 * The rule is fail-closed: a semantic control the Router cannot represent end to
 * end is refused by name, never accepted and silently ignored.
 *
 * Nothing here names a harness; the lists are properties of the wire protocols.
 */

import { RouterError } from "./errors.js";

/** Semantic generation controls no OpenAI-compatible surface here can represent. */
export const OPENAI_UNSUPPORTED_SEMANTIC_CONTROLS = [
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "stop_sequences",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "n",
  "seed",
  "logprobs",
  "top_logprobs",
] as const;

/** Chat Completions implements this control end to end. */
export const OPENAI_CHAT_SUPPORTED_CONTROLS = ["max_tokens"] as const;

/** Responses implements this control end to end. */
export const OPENAI_RESPONSES_SUPPORTED_CONTROLS = ["max_output_tokens"] as const;

/** Chat-shaped spelling the Responses surface does not accept. */
export const OPENAI_RESPONSES_REJECTED_CONTROLS = ["max_tokens"] as const;

/** Semantic controls the Anthropic-compatible surface cannot represent. */
export const ANTHROPIC_UNSUPPORTED_SEMANTIC_CONTROLS = [
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "thinking",
  "service_tier",
  "container",
  "mcp_servers",
] as const;

/** The Anthropic-compatible surface implements this control end to end. */
export const ANTHROPIC_SUPPORTED_CONTROLS = ["max_tokens"] as const;

export type RequestControlState = "supported" | "explicit_unsupported";

/** Derive the published per-control truth from the enforced lists. */
export function requestControlTruth(
  supported: readonly string[],
  unsupported: readonly string[],
): Record<string, RequestControlState> {
  const truth: Record<string, RequestControlState> = {};
  for (const control of supported) truth[control] = "supported";
  for (const control of unsupported) truth[control] = "explicit_unsupported";
  return truth;
}

export function unsupportedRequestControlError(
  control: string,
  surface: string,
  hint?: string,
): RouterError {
  const suffix = hint !== undefined ? `; ${hint}` : "";
  return new RouterError(
    "unsupported_capability",
    `${surface} does not accept '${control}'; refusing to ignore it silently${suffix}`,
  );
}

/**
 * Refuse the first present control the surface cannot represent. Absent controls
 * (an explicit `undefined` counts as absent) are not refused.
 */
export function rejectUnsupportedControls(
  body: Record<string, unknown>,
  controls: readonly string[],
  surface: string,
): RouterError | null {
  for (const control of controls) {
    if (body[control] !== undefined) {
      return unsupportedRequestControlError(control, surface);
    }
  }
  return null;
}
