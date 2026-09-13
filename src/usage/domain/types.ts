export type Metadata = Readonly<Record<string, unknown>>;

export type ProviderKind =
  | "first_party"
  | "aggregator"
  | "client_plan"
  | "manual"
  | "generic";

export type LifecycleStatus = "active" | "paused" | "cancelled" | "expired" | "archived";
export type ModelLifecycle = "active" | "deprecated" | "removed" | "unknown";
export type AccessRouteStatus = "available" | "degraded" | "unavailable" | "disabled" | "unknown";
export type QuotaStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "exhausted"
  | "unavailable"
  | "unknown";
export type QuotaEnforcement = "hard" | "soft" | "unknown";

export type Source =
  | "provider_official_api"
  | "provider_official_sdk"
  | "provider_official_cli"
  | "provider_local_state"
  | "router_measured"
  | "manual"
  | "derived"
  | "estimated";

export type Confidence = "exact" | "measured" | "calculated" | "estimated" | "unknown";

export type Metric =
  | { kind: "tokens" }
  | { kind: "input_tokens" }
  | { kind: "output_tokens" }
  | { kind: "requests" }
  | { kind: "credits" }
  | { kind: "currency"; currency: string }
  | { kind: "compute_units" }
  | { kind: "weighted_units" }
  | { kind: "percentage" }
  | { kind: "provider_defined"; providerKey: string };

export type WindowPolicy =
  | { kind: "rolling_duration"; durationSeconds: number }
  | {
      kind: "fixed_calendar";
      calendarUnit: "day" | "week" | "month" | "year" | string;
      timezone: string;
      anchor?: string;
    }
  | { kind: "billing_cycle"; anchorDate: string; timezone: string }
  | { kind: "provider_reported" }
  | { kind: "none" };

export interface Provider {
  id: string;
  displayName: string;
  kind: ProviderKind;
  status: LifecycleStatus | "enabled" | "disabled";
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  providerId: string;
  label: string;
  status: LifecycleStatus | "enabled" | "disabled";
  externalAccountHint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  providerId: string;
  displayName: string;
  kind: string;
  metadata: Metadata;
}

export interface SubscriptionPeriod {
  id: string;
  accountId: string;
  productId: string;
  status: LifecycleStatus;
  startedAt: string;
  endedAt?: string;
  billingAmount?: number;
  billingCurrency?: string;
  metadata: Metadata;
}

export interface ModelIdentity {
  id: string;
  canonicalName: string;
  vendor: string;
  family?: string;
  version?: string;
  lifecycle: ModelLifecycle;
  aliases: readonly string[];
  metadata: Metadata;
}

export interface AccessRoute {
  id: string;
  accountId: string;
  productId: string;
  subscriptionPeriodId?: string;
  modelIdentityId?: string;
  providerModelId: string;
  displayName: string;
  status: AccessRouteStatus;
  metadata: Metadata;
}

export interface QuotaGroup {
  id: string;
  productId: string;
  displayName: string;
  description?: string;
  sortOrder: number;
}

export interface QuotaBucket {
  id: string;
  accountId: string;
  productId: string;
  quotaGroupId?: string;
  displayName: string;
  metric: Metric;
  windowPolicy: WindowPolicy;
  limitValue?: number;
  unit: string;
  enforcement: QuotaEnforcement;
  status: QuotaStatus;
  providerKey?: string;
  metadata: Metadata;
}

export interface QuotaBinding {
  id: string;
  accessRouteId: string;
  quotaBucketId: string;
  consumptionRuleId?: string;
  activeFrom: string;
  activeTo?: string;
  priority?: number;
  metadata: Metadata;
}

export type Measurement =
  | "reported"
  | "tokens"
  | "input_tokens"
  | "output_tokens"
  | "requests"
  | "credits"
  | "currency"
  | "compute_units"
  | "weighted_units"
  | "provider_defined";

export interface ConsumptionRule {
  id: string;
  measurement: Measurement;
  weight?: number;
  observable: boolean;
  providerDefinedKey?: string;
  metadata: Metadata;
}

export interface UsageEvent {
  id: string;
  occurredAt: string;
  providerId: string;
  accountId: string;
  productId: string;
  accessRouteId?: string;
  modelIdentityId?: string;
  requestCorrelationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  requests?: number;
  providerUnits?: number;
  providerUnitName?: string;
  costAmount?: number;
  costCurrency?: string;
  source: Source;
  confidence: Confidence;
  metadata: Metadata;
}

export type CostEventKind = "usage" | "credit" | "top_up" | "subscription_fee" | "adjustment" | "unknown";

export interface CostEvent {
  id: string;
  occurredAt: string;
  providerId: string;
  accountId: string;
  productId: string;
  accessRouteId?: string;
  amount: number;
  currency: string;
  kind: CostEventKind;
  source: Source;
  confidence: Confidence;
  metadata: Metadata;
}

export interface QuotaSnapshot {
  id: string;
  quotaBucketId: string;
  observedAt: string;
  usedValue?: number;
  remainingValue?: number;
  limitValue?: number;
  usedFraction?: number;
  remainingFraction?: number;
  resetAt?: string;
  providerResetText?: string;
  source: Source;
  confidence: Confidence;
  stalenessAfter: string;
  rawSafeMetadata?: Metadata;
}

export type AdapterCapability =
  | "discover_accounts"
  | "discover_products"
  | "discover_models"
  | "discover_quota_graph"
  | "collect_usage_events"
  | "collect_quota_snapshots"
  | "collect_costs"
  | "collect_balances"
  | "collect_resets"
  | "manual_refresh"
  | "background_refresh";

export type AlertKind =
  | "usage_fraction"
  | "remaining_fraction"
  | "predicted_exhaustion"
  | "burn_rate"
  | "quota_exhausted"
  | "adapter_stale"
  | "adapter_failed"
  | "subscription_low_utilization";

export interface AlertRule {
  id: string;
  scope: string;
  scopeId: string;
  kind: AlertKind;
  threshold?: number;
  enabled: boolean;
  cooldown: number;
  metadata: Metadata;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  triggeredAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  metadata: Metadata;
}

export interface QuotaState {
  bucket: QuotaBucket;
  snapshot?: QuotaSnapshot;
  predictedExhaustionAt?: string;
}

export interface ResolveRouteHealthInput {
  accessRoute: AccessRoute;
  bindings: readonly QuotaBinding[];
  quotaStates: readonly QuotaState[];
  now?: string;
}

export interface ResolvedQuotaConstraint {
  bucketId: string;
  bindingId: string;
  status: QuotaStatus;
  enforcement: QuotaEnforcement;
  metric: Metric;
  unit: string;
  priority?: number;
  remainingFraction?: number;
  resetAt?: string;
  predictedExhaustionAt?: string;
  source?: Source;
  confidence?: Confidence;
}

export interface RouteHealth {
  accessRouteId: string;
  status: QuotaStatus;
  constraints: ResolvedQuotaConstraint[];
  primaryConstraint?: ResolvedQuotaConstraint;
}

export interface RouteGraph {
  accessRoute: AccessRoute;
  bindings: readonly QuotaBinding[];
  quotaStates: readonly QuotaState[];
}
