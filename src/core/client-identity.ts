/**
 * Application identifier carried by a request — diagnostics and compatibility
 * only.
 *
 * This value NEVER participates in authorization: it cannot grant tools,
 * elevate the CMMChat profile, select a provider or model, or weaken any
 * fallback guard. It exists so operators can observe which harnesses connect.
 *
 * The identifier is normalized onto a closed set. Anything unrecognized
 * collapses onto `other`, so an arbitrary header value can never invent a new
 * privileged member or grow the diagnostic cardinality without bound.
 */

export const CLIENT_CMMCHAT = "cmmchat";
export const CLIENT_QODER = "qoder";
export const CLIENT_HERMES = "hermes";
export const CLIENT_CODEX = "codex-client";
export const CLIENT_GENERIC = "generic-openai";
export const CLIENT_OTHER = "other";

export type RouterClientId =
  | typeof CLIENT_CMMCHAT
  | typeof CLIENT_QODER
  | typeof CLIENT_HERMES
  | typeof CLIENT_CODEX
  | typeof CLIENT_GENERIC
  | typeof CLIENT_OTHER;

/** Optional request header carrying the diagnostic application identifier. */
export const CLIENT_ID_HEADER = "x-cmm-client";

/** Upper bound applied before any comparison, so input size is not a lever. */
export const CLIENT_ID_MAX_LENGTH = 64;

const KNOWN_CLIENTS: ReadonlySet<string> = new Set<string>([
  CLIENT_CMMCHAT,
  CLIENT_QODER,
  CLIENT_HERMES,
  CLIENT_CODEX,
  CLIENT_GENERIC,
]);

/**
 * Normalize an optional application identifier onto the closed set. Absence
 * means `generic-openai`; an unrecognized value means `other`.
 */
export function normalizeClientId(raw: string | undefined): RouterClientId {
  if (typeof raw !== "string") return CLIENT_GENERIC;

  // Absence (nothing, or only whitespace) means the generic harness.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return CLIENT_GENERIC;

  const candidate = trimmed
    .toLowerCase()
    .slice(0, CLIENT_ID_MAX_LENGTH)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // A value that was present but sanitized away is an unrecognized value, not
  // an absence.
  if (candidate.length === 0) return CLIENT_OTHER;
  return KNOWN_CLIENTS.has(candidate) ? (candidate as RouterClientId) : CLIENT_OTHER;
}
