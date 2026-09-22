/**
 * Opaque application label — diagnostics only.
 *
 * CMM Code Router core deliberately knows NOTHING about which harnesses exist.
 * A request may carry an optional application label purely so operators can
 * observe who connects; there is no taxonomy, allow-list or enum of known
 * products, so a client that does not exist yet needs no core change.
 *
 * The label is:
 *   - optional: absence is a valid, normal state;
 *   - opaque: any value is preserved, sanitized and bounded;
 *   - inert: it can never affect profile authorization, model/provider
 *     selection, broker correlation, capability, or any fallback guard.
 */

/** Optional request header carrying the diagnostic application label. */
export const CLIENT_LABEL_HEADER = "x-cmm-client";

/** Upper bound applied before use, so input size is never a lever. */
export const CLIENT_LABEL_MAX_LENGTH = 64;

/**
 * Sanitize an optional application label.
 *
 * Returns `undefined` when the value is absent, blank, or consists only of
 * characters that cannot appear in a label — i.e. anything that would sanitize
 * to nothing is treated as absence rather than a synthetic category.
 */
export function normalizeClientLabel(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;

  const candidate = raw
    .trim()
    .toLowerCase()
    .slice(0, CLIENT_LABEL_MAX_LENGTH)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return candidate.length > 0 ? candidate : undefined;
}
