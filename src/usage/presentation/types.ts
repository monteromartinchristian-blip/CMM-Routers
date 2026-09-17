import type { RouteSurface } from "../../catalog/types.js";
import type { RouteCapabilitiesSummary } from "../../catalog/projection.js";
import type { Confidence, Metric, QuotaStatus, Source, WindowPolicy } from "../domain/types.js";

export type AccessOfferKind = "FREE" | "PROMO" | "INCLUDED" | "TRIAL" | "PAYG" | "UNKNOWN";

export interface AccessOfferSummary {
  kind: AccessOfferKind;
  modifiers?: readonly ("discounted" | "byok" | "sharedPool")[];
  source?: Source;
  confidence?: Confidence;
  observedAt?: string;
  validUntil?: string;
}

export type QuotaScope =
  | { kind: "provider"; providerId: string }
  | { kind: "account"; accountId: string }
  | { kind: "product"; productId: string }
  | { kind: "shared_pool"; productId: string }
  | { kind: "model"; modelIdentityId: string }
  | { kind: "route"; routeId: string }
  | { kind: "api_key"; providerId: string }
  | { kind: "provider_defined"; key: string };

export type QuotaEntitlementState =
  | "claimable"
  | "claimed"
  | "unavailable"
  | "expired"
  | "unknown";

export type QuotaEntitlementEligibility =
  | "eligible"
  | "requires_auth"
  | "ineligible"
  | "unknown";

export interface QuotaEntitlementSummary {
  state: QuotaEntitlementState;
  eligibility: QuotaEntitlementEligibility;
  amount?: number;
  unit: string;
  actionLabel?: string;
  requiresExplicitUserAction: true;
  source?: Source;
  confidence?: Confidence;
  observedAt?: string;
  validUntil?: string;
  appliesToRouteIds?: readonly string[];
}

export interface QuotaSummary {
  bucketId: string;
  displayName: string;
  metric: Metric;
  unit: string;
  windowPolicy: WindowPolicy;
  scope: QuotaScope;
  status: QuotaStatus;
  used?: number;
  remaining?: number;
  limit?: number;
  usedFraction?: number;
  remainingFraction?: number;
  resetAt?: string;
  providerResetText?: string;
  constraining: boolean;
  source?: Source;
  confidence?: Confidence;
  observedAt?: string;
  stale?: boolean;
  affectedRouteIds?: readonly string[];
  entitlement?: QuotaEntitlementSummary;
}

export type ProviderCategory =
  | "subscription"
  | "api"
  | "aggregator"
  | "custom_endpoint"
  | "local";

export type ProviderConnectionMethod =
  | "account"
  | "oauth"
  | "api_key"
  | "local_session"
  | "custom_endpoint";

export type ProviderDirectoryState =
  | "available"
  | "connecting"
  | "connected"
  | "degraded"
  | "disabled"
  | "reauth_required"
  | "unavailable";

export interface ProviderDirectoryCapabilities {
  modelDiscovery: boolean;
  quotaDiscovery: boolean;
  balanceDiscovery: boolean;
  costDiscovery: boolean;
  pricingDiscovery: boolean;
}

export interface ProviderDirectoryEntry {
  integrationType: string;
  displayName: string;
  shortDescription?: string;
  iconKey?: string;
  category: ProviderCategory;
  connectionMethods: readonly ProviderConnectionMethod[];
  state: ProviderDirectoryState;
  connectedInstanceCount: number;
  capabilities: ProviderDirectoryCapabilities;
}

export interface VisibilityPreference {
  scope: "global" | `workspace:${string}`;
  providerId?: string;
  productId?: string;
  routeId?: string;
  state: "visible" | "hidden" | "inherit";
}

/**
 * Usage-observed route status.
 *
 * This is a historical observation collected by CMM Usage. It is deliberately
 * named apart from Router routability so it can never be mistaken for current
 * operational availability; Router owns whether a route can actually execute.
 */
export type UsageRouteStatus =
  | "available"
  | "temporarily_unavailable"
  | "unknown";

/**
 * A current operational route: Router truth with Usage intelligence attached.
 *
 * Identity, provider/account/product/model/connection facts, capabilities,
 * routability and visibility are copied unchanged from the canonical Router
 * catalog projection. Usage only attaches its own observability fields
 * (`offer`, `quota`, `usageStatus`, `freshness`) and never overwrites Router
 * fields.
 */
export interface CatalogRouteEntry {
  routeId: string;
  modelIdentityId: string;
  connectionId: string;
  providerId: string;
  providerModelId: string;
  executionProfile: string;
  provider: {
    id: string;
    displayName: string;
    iconKey?: string;
  };
  account?: {
    id: string;
    label: string;
  };
  product: {
    id: string;
    displayName: string;
    category: "subscription" | "api" | "aggregator" | "custom" | "local";
  };
  model: {
    id: string;
    displayName: string;
    family?: string;
    aliases: readonly string[];
  };
  /** Router routability. Never derived from Usage observations. */
  routable: boolean;
  /** Router capabilities for the exact route. */
  capabilities: RouteCapabilitiesSummary;
  /** Router billing class for the exact route. */
  billingClass: string;
  /** Router effective visibility, by consumer surface. */
  visibility: {
    visibleOn: readonly RouteSurface[];
  };
  /** Usage offer intelligence for this exact route. */
  offer: AccessOfferSummary;
  /** Usage quota intelligence bound to this exact route. */
  quota: readonly QuotaSummary[];
  /** Usage freshness of the attached quota observations. */
  freshness?: {
    observedAt?: string;
    stale: boolean;
  };
  /** Historical Usage observation. Never current Router availability. */
  usageStatus: UsageRouteStatus;
}

/**
 * Compatibility view of Router effective route visibility.
 *
 * It replaces the former SQLite-preference read: `state` is derived from
 * Router `visibleOn`, so a route hidden from every consumer surface reports
 * `hidden` even when a legacy preference says otherwise.
 */
export interface CatalogRouteVisibilityView {
  scope: "global";
  providerId: string;
  productId: string;
  routeId: string;
  state: "visible" | "hidden";
}

export interface CatalogProviderView {
  directory: ProviderDirectoryEntry;
  instanceIds: readonly string[];
}
