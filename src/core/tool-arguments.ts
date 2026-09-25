/**
 * Provider tool-argument validation.
 *
 * A provider's tool-call arguments arrive as a JSON string. If that string is not
 * valid JSON, the Router must never invent arguments: substituting `{}` (or
 * forwarding the raw fragment as if it were usable) would hand the client a
 * syntactically valid call with fabricated parameters.
 *
 * The canonical rule is therefore fail-closed: either the arguments parse
 * exactly, or the request terminates with a protocol error. No heuristic repair.
 */

import { RouterError } from "./errors.js";

export type ParsedToolArguments =
  | { ok: true; value: unknown }
  | { ok: false; error: RouterError };

/**
 * Parse provider tool arguments. Empty/whitespace input is treated as the empty
 * argument object, which is what a no-argument tool call legitimately looks like
 * on the wire. Anything else must parse.
 */
export function parseToolArguments(raw: string): ParsedToolArguments {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return {
      ok: false,
      error: new RouterError(
        "provider_protocol_error",
        "Provider emitted tool arguments that are not valid JSON; refusing to fabricate arguments",
      ),
    };
  }
}

/**
 * Validate every accumulated tool-call argument payload before any call is
 * surfaced. Returns the first error, or null when all payloads are usable.
 */
export function validateToolArguments(argumentsList: readonly string[]): RouterError | null {
  for (const raw of argumentsList) {
    const parsed = parseToolArguments(raw);
    if (!parsed.ok) return parsed.error;
  }
  return null;
}
