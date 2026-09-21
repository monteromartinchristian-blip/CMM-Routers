/**
 * Legacy consumer-capability surface.
 *
 * The product model is now profile-based: a request authenticates either the
 * CMMChat profile (permanently CHAT_ONLY) or the Code Router profile
 * (CHAT_AND_TOOLS, subject to truthful provider/model capability). The old
 * "consumer" vocabulary is retained here as a thin compatibility layer so
 * existing imports, tests and callers keep working unchanged.
 *
 * @deprecated Import from `./router-profile.js` instead. These aliases will be
 * removed once the compatibility window closes.
 */

import {
  PROFILE_CMMCHAT,
  PROFILE_CODE,
  effectiveProfileToolCapability,
  type RouterProfile,
} from "./router-profile.js";

/**
 * @deprecated Legacy alias for the CMMChat profile.
 */
export const CONSUMER_CMMCHAT = PROFILE_CMMCHAT;

/**
 * @deprecated Legacy alias for the Code Router profile. The Code Router profile
 * is no longer a vendor identity and no longer grants tools by itself.
 */
export const CONSUMER_QODER = PROFILE_CODE;

/**
 * @deprecated Use `RouterProfile`.
 */
export type ConsumerId = RouterProfile;

/**
 * @deprecated Use `effectiveProfileToolCapability`.
 */
export const effectiveToolCapability = effectiveProfileToolCapability;

/** Legacy compatibility bearer variable name. */
export const QODER_TOKEN_ENV = "CMM_QODER_TOKEN";

/** Canonical Code Router bearer variable name. */
export const CODE_ROUTER_TOKEN_ENV = "CMM_CODE_ROUTER_TOKEN";
