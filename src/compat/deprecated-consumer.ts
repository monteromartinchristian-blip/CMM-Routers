/**
 * Deprecated consumer-capability surface — compatibility layer.
 *
 * The product model is profile-based: a request authenticates either the
 * CMMChat profile (permanently CHAT_ONLY) or the Code Router profile
 * (CHAT_AND_TOOLS, subject to truthful provider/model capability).
 *
 * The old "consumer" vocabulary lived in `src/core`; it is moved here so the
 * core carries no historical product identity. Existing imports keep working.
 *
 * @deprecated Import from `../core/router-profile.js` instead.
 */

import {
  PROFILE_CMMCHAT,
  PROFILE_CODE,
  effectiveProfileToolCapability,
  type RouterProfile,
} from "../core/router-profile.js";
import { LEGACY_CODE_ROUTER_BEARER_ENV } from "./legacy-identifiers.js";

/** @deprecated Legacy alias for the CMMChat profile. */
export const CONSUMER_CMMCHAT = PROFILE_CMMCHAT;

/** @deprecated Legacy alias for the Code Router profile. */
export const CONSUMER_QODER = PROFILE_CODE;

/** @deprecated Use `RouterProfile`. */
export type ConsumerId = RouterProfile;

/** @deprecated Use `effectiveProfileToolCapability`. */
export const effectiveToolCapability = effectiveProfileToolCapability;

/** @deprecated Use `LEGACY_CODE_ROUTER_BEARER_ENV`. */
export const QODER_TOKEN_ENV = LEGACY_CODE_ROUTER_BEARER_ENV;

/** Canonical Code Router bearer environment variable name. */
export const CODE_ROUTER_TOKEN_ENV = "CMM_CODE_ROUTER_TOKEN";
