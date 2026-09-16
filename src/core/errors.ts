export type RouterErrorCode =
  | "invalid_request"
  | "unknown_provider"
  | "unknown_model"
  | "unsupported_capability"
  | "provider_unavailable"
  | "provider_auth_required"
  | "provider_quota_exhausted"
  /**
   * Account-state block: the provider refuses service because money is owed
   * (unsettled usage / outstanding balance). Distinct from quota exhaustion,
   * which is a spent allowance with a settled account: retrying, waiting or
   * raising a limit cannot clear a billing block, only settlement can.
   */
  | "provider_billing_blocked"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_protocol_error"
  | "router_unauthorized"
  | "router_internal_error";

/**
 * Phrases that mark an account-state billing block rather than an exhausted
 * allowance. Providers return these on HTTP 402; the router must not collapse
 * them into "zero balance", because the operator action differs (settle the
 * account) and usage accounting must distinguish the two states.
 */
const UNSETTLED_BILLING_MARKERS = [
  "unsettled",
  "settle the outstanding",
  "outstanding balance",
  "settle your balance",
  "billing is blocked",
  "billing blocked",
  "account is blocked",
  "payment required",
  "account suspended",
] as const;

export function isUnsettledBillingState(bodyText: string): boolean {
  const lowered = bodyText.toLowerCase();
  return UNSETTLED_BILLING_MARKERS.some((marker) => lowered.includes(marker));
}

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RouterError";
  }
}
