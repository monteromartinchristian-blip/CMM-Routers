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

export interface CatalogRouteEntry {
  routeId: string;
  modelIdentityId?: string;
  provider: {
    id: string;
    displayName: string;
    iconKey?: string;
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
    capabilities?: readonly string[];
  };
  offer: AccessOfferSummary;
  quota: readonly QuotaSummary[];
  availability: "available" | "temporarily_unavailable" | "unknown";
  visibility: "visible" | "hidden";
  freshness?: {
    observedAt?: string;
    stale: boolean;
  };
}

export interface CatalogProviderView {
  directory: ProviderDirectoryEntry;
  instanceIds: readonly string[];
}
