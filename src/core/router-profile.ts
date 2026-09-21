/**
 * Router profile — the authorization subject.
 *
 * A profile is the authenticated product capability, independent of the
 * application that presented the credential. Application identity is
 * diagnostics-only metadata and is deliberately absent from this module, so no
 * application-supplied value can participate in the capability decision.
 */

export const PROFILE_CMMCHAT = "cmmchat" as const;
export const PROFILE_CODE = "code" as const;

export type RouterProfile = typeof PROFILE_CMMCHAT | typeof PROFILE_CODE;

/**
 * Effective tool capability = profile policy AND truthful provider capability.
 *
 * CMMChat is intentionally CHAT_ONLY on every provider: it must never
 * implicitly gain shell, filesystem, edit, or arbitrary tool execution, and no
 * request metadata can elevate it. The Code Router profile may use tools only
 * when the resolved provider model reports a proven structured upstream
 * round-trip (CHAT_AND_TOOLS). Provider capability alone never grants tools to
 * the CMMChat profile, and the Code Router profile alone never grants tools on
 * a CHAT_ONLY provider.
 */
export function effectiveProfileToolCapability(
  profile: RouterProfile,
  providerCapability: string | undefined,
): "CHAT_AND_TOOLS" | "CHAT_ONLY" {
  if (profile !== PROFILE_CODE) return "CHAT_ONLY";
  return providerCapability === "CHAT_AND_TOOLS" ? "CHAT_AND_TOOLS" : "CHAT_ONLY";
}
