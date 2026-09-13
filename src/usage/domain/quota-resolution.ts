import type {
  Metric,
  QuotaBinding,
  QuotaState,
  QuotaStatus,
  ResolvedQuotaConstraint,
  ResolveRouteHealthInput,
  RouteHealth,
} from "./types.js";

function asTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bindingIsActive(binding: QuotaBinding, now: number): boolean {
  const from = asTime(binding.activeFrom);
  const to = asTime(binding.activeTo);
  return (from === undefined || from <= now) && (to === undefined || now < to);
}

function metricKey(metric: Metric): string {
  switch (metric.kind) {
    case "currency":
      return `currency:${metric.currency}`;
    case "provider_defined":
      return `provider_defined:${metric.providerKey}`;
    default:
      return metric.kind;
  }
}

function comparable(a: ResolvedQuotaConstraint, b: ResolvedQuotaConstraint): boolean {
  return metricKey(a.metric) === metricKey(b.metric) && a.unit === b.unit;
}

function forecastBeforeReset(value: ResolvedQuotaConstraint): number | undefined {
  const forecast = asTime(value.predictedExhaustionAt);
  if (forecast === undefined) return undefined;
  const reset = asTime(value.resetAt);
  if (reset !== undefined && forecast >= reset) return undefined;
  return forecast;
}

function compareConstraints(a: ResolvedQuotaConstraint, b: ResolvedQuotaConstraint): number {
  const aHardExhausted = a.enforcement === "hard" && a.status === "exhausted";
  const bHardExhausted = b.enforcement === "hard" && b.status === "exhausted";
  if (aHardExhausted !== bHardExhausted) return aHardExhausted ? -1 : 1;

  const aForecast = forecastBeforeReset(a);
  const bForecast = forecastBeforeReset(b);
  if (aForecast !== undefined || bForecast !== undefined) {
    if (aForecast === undefined) return 1;
    if (bForecast === undefined) return -1;
    if (aForecast !== bForecast) return aForecast - bForecast;
  }

  if (
    comparable(a, b) &&
    a.remainingFraction !== undefined &&
    b.remainingFraction !== undefined &&
    a.remainingFraction !== b.remainingFraction
  ) {
    return a.remainingFraction - b.remainingFraction;
  }

  const aPriority = a.priority ?? Number.POSITIVE_INFINITY;
  const bPriority = b.priority ?? Number.POSITIVE_INFINITY;
  if (aPriority !== bPriority) return aPriority - bPriority;

  return a.bucketId.localeCompare(b.bucketId);
}

function constraintFrom(binding: QuotaBinding, state: QuotaState): ResolvedQuotaConstraint {
  const snapshot = state.snapshot;
  return {
    bucketId: state.bucket.id,
    bindingId: binding.id,
    status: state.bucket.status,
    enforcement: state.bucket.enforcement,
    metric: state.bucket.metric,
    unit: state.bucket.unit,
    ...(binding.priority === undefined ? {} : { priority: binding.priority }),
    ...(snapshot?.remainingFraction === undefined
      ? {}
      : { remainingFraction: snapshot.remainingFraction }),
    ...(snapshot?.resetAt === undefined ? {} : { resetAt: snapshot.resetAt }),
    ...(state.predictedExhaustionAt === undefined
      ? {}
      : { predictedExhaustionAt: state.predictedExhaustionAt }),
    ...(snapshot?.source === undefined ? {} : { source: snapshot.source }),
    ...(snapshot?.confidence === undefined ? {} : { confidence: snapshot.confidence }),
  };
}

function routeStatus(constraints: readonly ResolvedQuotaConstraint[]): QuotaStatus {
  if (constraints.some((value) => value.enforcement === "hard" && value.status === "exhausted")) {
    return "exhausted";
  }

  if (
    constraints.some(
      (value) =>
        value.status === "critical" ||
        value.status === "exhausted" ||
        forecastBeforeReset(value) !== undefined,
    )
  ) {
    return "critical";
  }

  if (constraints.some((value) => value.status === "warning")) return "warning";
  if (constraints.length > 0 && constraints.every((value) => value.status === "healthy")) {
    return "healthy";
  }
  return "unknown";
}

export function resolveRouteHealth(input: ResolveRouteHealthInput): RouteHealth {
  if (input.accessRoute.status === "unavailable" || input.accessRoute.status === "disabled") {
    return {
      accessRouteId: input.accessRoute.id,
      status: "unavailable",
      constraints: [],
    };
  }

  const now = asTime(input.now) ?? Date.now();
  const statesByBucket = new Map(input.quotaStates.map((state) => [state.bucket.id, state]));
  const constraints = input.bindings
    .filter(
      (binding) =>
        binding.accessRouteId === input.accessRoute.id && bindingIsActive(binding, now),
    )
    .flatMap((binding) => {
      const state = statesByBucket.get(binding.quotaBucketId);
      return state === undefined ? [] : [constraintFrom(binding, state)];
    })
    .sort(compareConstraints);

  const primaryConstraint = constraints[0];
  return {
    accessRouteId: input.accessRoute.id,
    status: routeStatus(constraints),
    constraints,
    ...(primaryConstraint === undefined ? {} : { primaryConstraint }),
  };
}
