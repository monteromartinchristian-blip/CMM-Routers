import type { QuotaBucket, QuotaSnapshot } from "../domain/types.js";
import type { QuotaScope, QuotaSummary } from "./types.js";

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
  };
}
