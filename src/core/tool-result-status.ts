/**
 * Canonical tool-result outcome.
 *
 * Whether a client-executed tool succeeded or failed is semantic information: a
 * failed tool must not be indistinguishable from a successful one downstream.
 *
 * The canonical model therefore carries an explicit outcome, and each protocol
 * edge maps it as truthfully as its wire allows:
 *
 *   - Anthropic Messages has a real `is_error` bit, so it round-trips;
 *   - bridges that flatten a tool result into router-authored text encode the
 *     outcome in that text rather than erasing it;
 *   - wired protocols with no error bit (OpenAI Chat/Responses `role: tool`)
 *     preserve the content verbatim; the status stays internal.
 *
 * The concept is deliberately generic: it names no harness and no vendor.
 */

import type { RouterToolResultStatus } from "./model.js";

/**
 * Insertable marker used by bridges that must flatten a tool result into text.
 * Empty for success so existing successful-result text is byte-identical.
 */
export function toolResultStatusSuffix(status: RouterToolResultStatus | undefined): string {
  return status === "error" ? " error" : "";
}
