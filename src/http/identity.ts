import { verifyBearer, tokensEqual } from "../security/bearer-auth.js";
import { RouterError } from "../core/errors.js";
import { PROFILE_CMMCHAT, PROFILE_CODE, type RouterProfile } from "../core/router-profile.js";
import {
  CLIENT_CMMCHAT,
  CLIENT_GENERIC,
  CLIENT_ID_HEADER,
  CLIENT_QODER,
  normalizeClientId,
  type RouterClientId,
} from "../core/client-identity.js";

export { CLIENT_ID_HEADER };

/**
 * Server-side bearer configuration.
 *
 * `cmmchatToken` is required and authenticates the CMMChat profile, which is
 * permanently CHAT_ONLY. The Code Router profile is authenticated by the
 * canonical bearer and/or its legacy compatibility alias; both map to the SAME
 * profile, so no precedence between them is required.
 */
export interface ServerTokens {
  cmmchatToken: string;
  codeRouterToken?: string | undefined;
  legacyQoderToken?: string | undefined;
}

export interface ResolvedIdentity {
  profile: RouterProfile;
  /** Diagnostics only; never an authorization input. */
  clientId: RouterClientId;
}

/** Which configured credential validated. Diagnostic and default-selection only. */
type CredentialKind = "cmmchat" | "code-router" | "legacy-qoder";

function configured(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function matchCredential(
  authorizationHeader: string | undefined,
  tokens: ServerTokens,
): CredentialKind | null {
  if (!authorizationHeader) return null;

  // CMMChat is checked first, but the startup distinctness guard makes the
  // order irrelevant for correctness: a secret can never match two profiles.
  if (verifyBearer(authorizationHeader, tokens.cmmchatToken)) return "cmmchat";

  if (configured(tokens.codeRouterToken) && verifyBearer(authorizationHeader, tokens.codeRouterToken)) {
    return "code-router";
  }

  if (configured(tokens.legacyQoderToken) && verifyBearer(authorizationHeader, tokens.legacyQoderToken)) {
    return "legacy-qoder";
  }

  return null;
}

/**
 * Reject an ambiguous server configuration at startup instead of silently
 * degrading to CMMChat at request time.
 *
 * A collision between the CMMChat secret and either Code Router secret would
 * make the profile mapping ambiguous, so it fails closed. The canonical and
 * legacy Code Router secrets sharing one value is NOT ambiguous (both map to
 * the Code Router profile), so it is accepted as two names for one credential.
 *
 * No configured value is ever included in the error.
 */
export function assertDistinctServerTokens(tokens: ServerTokens): void {
  if (!configured(tokens.cmmchatToken)) {
    throw new RouterError(
      "router_misconfigured",
      "The CMMChat bearer token must be configured and non-empty",
    );
  }

  const codeSecrets: Array<[label: string, value: string | undefined]> = [
    ["canonical Code Router bearer", tokens.codeRouterToken],
    ["legacy Code Router bearer", tokens.legacyQoderToken],
  ];

  for (const [label, value] of codeSecrets) {
    if (value === undefined) continue;
    if (value.length === 0) {
      throw new RouterError("router_misconfigured", `The ${label} is configured but empty`);
    }
    if (tokensEqual(value, tokens.cmmchatToken)) {
      throw new RouterError(
        "router_misconfigured",
        `The CMMChat bearer and the ${label} must be distinct; refusing to start with an ambiguous profile mapping`,
      );
    }
  }
}

/**
 * Resolve the authenticated profile and the diagnostic application identifier.
 * Returns null when no configured secret validates (the caller must 401).
 *
 * There is no fallback of any kind: an unrecognized credential never resolves
 * to CMMChat, and request metadata never changes the resulting profile.
 */
export function resolveRequestIdentity(
  authorizationHeader: string | undefined,
  tokens: ServerTokens,
  clientHeader: string | undefined,
): ResolvedIdentity | null {
  const kind = matchCredential(authorizationHeader, tokens);
  if (kind === null) return null;

  if (kind === "cmmchat") {
    // Fixed: request metadata cannot alter the CMMChat profile's diagnostics.
    return { profile: PROFILE_CMMCHAT, clientId: CLIENT_CMMCHAT };
  }

  const providedClient = typeof clientHeader === "string" ? clientHeader.trim() : "";
  if (providedClient.length > 0) {
    return { profile: PROFILE_CODE, clientId: normalizeClientId(clientHeader) };
  }

  // Absence defaults to the generic harness for the canonical bearer, and to
  // the historical application for the legacy compatibility bearer.
  return {
    profile: PROFILE_CODE,
    clientId: kind === "legacy-qoder" ? CLIENT_QODER : CLIENT_GENERIC,
  };
}
