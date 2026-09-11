import { RouterError } from "./errors.js";
import type { RouterMessage } from "./model.js";

/**
 * Maximum tool-result payload accepted from a consumer before it may enter
 * provider continuation. Bounds provider-bound context growth and prevents an
 * oversize result from being forwarded upstream.
 */
export const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

/**
 * Enforce the tool-result size bound at the HTTP boundary. A tool message that
 * exceeds the bound fails closed BEFORE any provider adapter runs, so the
 * oversize payload never reaches the provider.
 */
export function assertToolResultsWithinBound(messages: RouterMessage[]): void {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (typeof message.content !== "string") continue;
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (bytes > MAX_TOOL_RESULT_BYTES) {
      throw new RouterError(
        "invalid_request",
        `Tool result exceeds the ${MAX_TOOL_RESULT_BYTES} byte limit`,
      );
    }
  }
}
