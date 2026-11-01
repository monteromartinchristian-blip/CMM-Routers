/**
 * Router profile — the authorization subject.
 *
 * A profile is the authenticated authorization identity, independent of the
 * application that presented the credential. Application identity is
 * diagnostics-only metadata and is deliberately absent from this module, so no
 * application-supplied value can participate in the capability decision.
 *
 * CHAT  — CMMChat's normal profile. Conversation, streaming, multimodal input,
 *         reasoning and explicitly granted scoped actions.
 * AGENT — profile for general tool loops in which the caller owns execution
 *         (harnesses and agents that run tools themselves). Concrete product
 *         names belong to the compatibility layer, never to the core.
 *
 * `CMM Code Router` is the historical name of the AGENT profile, not a third
 * profile and not a security primitive.
 *
 * The profile is resolved from a server-side bearer secret before any request
 * field is read. The single resolver lives in `http/identity.ts`; the single
 * tool-access decision lives in `core/tool-access-policy.ts`.
 */

export const PROFILE_CHAT = "CHAT" as const;
export const PROFILE_AGENT = "AGENT" as const;

export type RouterProfile = typeof PROFILE_CHAT | typeof PROFILE_AGENT;

export const ROUTER_PROFILES: readonly RouterProfile[] = [PROFILE_CHAT, PROFILE_AGENT];

export function isRouterProfile(value: unknown): value is RouterProfile {
  return value === PROFILE_CHAT || value === PROFILE_AGENT;
}

/**
 * Legacy effective tool capability = profile policy AND provider capability.
 *
 * @deprecated Superseded by `resolveToolAccess` (`core/tool-access-policy.ts`),
 * which also accepts the CHAT scoped-action grant. Because this function has no
 * grant input, a CHAT result here means "no scoped action granted", never
 * "CHAT can never use tools" and never "CHAT may transport caller-supplied
 * tools".
 *
 * Retained for the `src/compat` shim and the capability-policy unit tests that
 * describe the pre-scoped-action contract.
 */
export function effectiveProfileToolCapability(
  profile: RouterProfile,
  providerCapability: string | undefined,
): "CHAT_AND_TOOLS" | "CHAT_ONLY" {
  if (profile !== PROFILE_AGENT) return "CHAT_ONLY";
  return providerCapability === "CHAT_AND_TOOLS" ? "CHAT_AND_TOOLS" : "CHAT_ONLY";
}
