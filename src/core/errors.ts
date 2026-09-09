export type RouterErrorCode =
  | "invalid_request"
  | "unknown_provider"
  | "unknown_model"
  | "unsupported_capability"
  | "provider_unavailable"
  | "provider_auth_required"
  | "provider_quota_exhausted"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_protocol_error"
  | "router_unauthorized"
  | "router_internal_error";

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
