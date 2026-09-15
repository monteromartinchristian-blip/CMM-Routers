import type { QuotaBucket, QuotaSnapshot } from "../domain/types.js";
import type {
  QuotaEntitlementEligibility,
  QuotaEntitlementState,
  QuotaEntitlementSummary,
  QuotaScope,
  QuotaSummary,
} from "./types.js";

interface ProjectQuotaSummaryInput {
  bucket: QuotaBucket;
  snapshot?: QuotaSnapshot;
  status: QuotaSummary["status"];
  stale: boolean;
  constraining: boolean;
  affectedRouteIds: readonly string[];
}

function metadataString(bucket: QuotaBucket, key: string): string | undefined {
  const value = bucket.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataNumber(bucket: QuotaBucket, key: string): number | undefined {
  const value = bucket.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataStringArray(bucket: QuotaBucket, key: string): string[] | undefined {
  const value = bucket.metadata[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length === value.length ? strings : undefined;
}

const entitlementStates = new Set<QuotaEntitlementState>([
  "claimable",
  "claimed",
  "unavailable",
  "expired",
  "unknown",
]);

const entitlementEligibility = new Set<QuotaEntitlementEligibility>([
  "eligible",
  "requires_auth",
  "ineligible",
  "unknown",
]);

function projectEntitlement(bucket: QuotaBucket): QuotaEntitlementSummary | undefined {
  const rawState = metadataString(bucket, "entitlementState") as QuotaEntitlementState | undefined;
  if (rawState === undefined || !entitlementStates.has(rawState)) return undefined;

  const rawEligibility = metadataString(bucket, "entitlementEligibility") as QuotaEntitlementEligibility | undefined;
  const eligibility = rawEligibility !== undefined && entitlementEligibility.has(rawEligibility)
    ? rawEligibility
    : "unknown";
  const source = metadataString(bucket, "entitlementSource") as QuotaEntitlementSummary["source"];
  const confidence = metadataString(bucket, "entitlementConfidence") as QuotaEntitlementSummary["confidence"];
  const appliesToRouteIds = metadataStringArray(bucket, "entitlementAppliesToRouteIds");
  const amount = metadataNumber(bucket, "entitlementAmount");
  const actionLabel = metadataString(bucket, "entitlementActionLabel");
  const observedAt = metadataString(bucket, "entitlementObservedAt");
  const validUntil = metadataString(bucket, "entitlementValidUntil");

  return {
    state: rawState,
    eligibility,
    unit: metadataString(bucket, "entitlementUnit") ?? bucket.unit,
    requiresExplicitUserAction: true,
    ...(amount === undefined ? {} : { amount }),
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(source === undefined ? {} : { source }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(appliesToRouteIds === undefined
      ? {}
      : { appliesToRouteIds: [...appliesToRouteIds].sort() }),
  };
}

export function quotaScope(
  bucket: QuotaBucket,
  affectedRouteIds: readonly string[],
): QuotaScope {
  const scope = metadataString(bucket, "scope");
  switch (scope) {
    case "shared_pool":
      return { kind: "shared_pool", productId: bucket.productId };
    case "provider": {
      const providerId = metadataString(bucket, "providerId");
      return providerId === undefined
        ? { kind: "product", productId: bucket.productId }
        : { kind: "provider", providerId };
    }
    case "account":
      return { kind: "account", accountId: bucket.accountId };
    case "route":
      return affectedRouteIds.length === 1
        ? { kind: "route", routeId: affectedRouteIds[0]! }
        : { kind: "product", productId: bucket.productId };
    case "model": {
      const modelIdentityId = metadataString(bucket, "modelIdentityId");
      return modelIdentityId === undefined
        ? { kind: "product", productId: bucket.productId }
        : { kind: "model", modelIdentityId };
    }
    case "api_key": {
      const providerId = metadataString(bucket, "providerId");
      return providerId === undefined
        ? { kind: "product", productId: bucket.productId }
        : { kind: "api_key", providerId };
    }
    default:
      return { kind: "product", productId: bucket.productId };
  }
}

export function projectQuotaSummary(input: ProjectQuotaSummaryInput): QuotaSummary {
  const { bucket, snapshot } = input;
  const entitlement = projectEntitlement(bucket);
  return {
    bucketId: bucket.id,
    displayName: bucket.displayName,
    metric: bucket.metric,
    unit: bucket.unit,
    windowPolicy: bucket.windowPolicy,
    scope: quotaScope(bucket, input.affectedRouteIds),
    status: input.status,
    constraining: input.constraining,
    ...(snapshot?.usedValue === undefined ? {} : { used: snapshot.usedValue }),
    ...(snapshot?.remainingValue === undefined ? {} : { remaining: snapshot.remainingValue }),
    ...((snapshot?.limitValue ?? bucket.limitValue) === undefined
      ? {}
      : { limit: snapshot?.limitValue ?? bucket.limitValue }),
    ...(snapshot?.usedFraction === undefined ? {} : { usedFraction: snapshot.usedFraction }),
    ...(snapshot?.remainingFraction === undefined
      ? {}
      : { remainingFraction: snapshot.remainingFraction }),
    ...(snapshot?.resetAt === undefined ? {} : { resetAt: snapshot.resetAt }),
    ...(snapshot?.providerResetText === undefined
      ? {}
      : { providerResetText: snapshot.providerResetText }),
    ...(snapshot?.source === undefined ? {} : { source: snapshot.source }),
    ...(snapshot?.confidence === undefined ? {} : { confidence: snapshot.confidence }),
    ...(snapshot?.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
    stale: input.stale,
    ...(input.affectedRouteIds.length === 0
      ? {}
      : { affectedRouteIds: [...input.affectedRouteIds].sort() }),
    ...(entitlement === undefined ? {} : { entitlement }),
  };
}
