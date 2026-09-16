/**
 * Shared Server-Sent Events helpers for OpenAI-compatible provider transports.
 *
 * The router talks to every HTTP provider through the same SSE vocabulary
 * (blank-line delimited frames whose payload is carried on `data:` lines), so
 * the framing rules live here once instead of being re-implemented per
 * provider. Anthropic-specific event semantics stay in their provider module.
 */

/**
 * Maximum size of one unterminated upstream SSE frame. A provider that streams
 * a delimited frame without ever terminating it must not grow Router memory
 * without bound; overflow fails the request closed with a protocol error.
 */
export const MAX_PROVIDER_SSE_FRAME_BYTES = 1024 * 1024;

export function splitSseChunks(bodyText: string): string[] {
  return bodyText
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Extract the JSON payload of ONE SSE frame. Handles frames with or without
 * the `data:` prefix and returns null for keep-alive/`[DONE]`/empty frames.
 */
export function parseSseDataLine(chunk: string): string | null {
  const lines = chunk.split("\n").map((l) => l.trim());
  const dataLines = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length).trim());
  if (dataLines.length === 0) return null;
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") return null;
  return joined;
}
