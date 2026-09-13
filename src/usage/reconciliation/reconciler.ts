import type { Confidence, QuotaSnapshot, Source } from "../domain/types.js";

export interface ReconciledQuotaState {
  bucketId: string;
  selected?: QuotaSnapshot;
  observations: QuotaSnapshot[];
  conflict: boolean;
  stale: boolean;
}

const sourceRank: Record<Source, number> = {
  provider_official_api: 0,
  provider_official_sdk: 1,
  provider_official_cli: 2,
  provider_local_state: 3,
  router_measured: 4,
  manual: 5,
  derived: 6,
  estimated: 7,
};

const confidenceRank: Record<Confidence, number> = {
  exact: 0,
  measured: 1,
  calculated: 2,
  estimated: 3,
  unknown: 4,
};

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isStale(snapshot: QuotaSnapshot, nowMs: number): boolean {
  return timestamp(snapshot.stalenessAfter) <= nowMs;
}

function freshnessLifetime(snapshot: QuotaSnapshot): number {
  return Math.max(0, timestamp(snapshot.stalenessAfter) - timestamp(snapshot.observedAt));
}

function observationsAreComparablyFresh(a: QuotaSnapshot, b: QuotaSnapshot): boolean {
  const observedDifference = Math.abs(timestamp(a.observedAt) - timestamp(b.observedAt));
  const comparableWindow = Math.min(freshnessLifetime(a), freshnessLifetime(b));
  return observedDifference <= comparableWindow;
}

function compareSnapshots(a: QuotaSnapshot, b: QuotaSnapshot, nowMs: number): number {
  const aStale = isStale(a, nowMs);
  const bStale = isStale(b, nowMs);
  if (aStale !== bStale) return aStale ? 1 : -1;

  const observedDifference = timestamp(b.observedAt) - timestamp(a.observedAt);
  if (!observationsAreComparablyFresh(a, b) && observedDifference !== 0) {
    return observedDifference;
  }

  const sourceDifference = sourceRank[a.source] - sourceRank[b.source];
  if (sourceDifference !== 0) return sourceDifference;

  const confidenceDifference = confidenceRank[a.confidence] - confidenceRank[b.confidence];
  if (confidenceDifference !== 0) return confidenceDifference;

  if (observedDifference !== 0) return observedDifference;

  return a.id.localeCompare(b.id);
}

const comparableFields = [
  "usedValue",
  "remainingValue",
  "limitValue",
  "usedFraction",
  "remainingFraction",
  "resetAt",
  "providerResetText",
] as const satisfies readonly (keyof QuotaSnapshot)[];

function observationsDisagree(a: QuotaSnapshot, b: QuotaSnapshot): boolean {
  if (a.observedAt !== b.observedAt) return false;

  for (const field of comparableFields) {
    const aValue = a[field];
    const bValue = b[field];
    if (aValue !== undefined && bValue !== undefined && aValue !== bValue) return true;
  }
  return false;
}

export function reconcileQuotaSnapshots(
  snapshots: readonly QuotaSnapshot[],
  now: Date,
): ReconciledQuotaState {
  if (snapshots.length === 0) {
    return {
      bucketId: "",
      observations: [],
      conflict: false,
      stale: true,
    };
  }

  const bucketId = snapshots[0]?.quotaBucketId ?? "";
  if (snapshots.some((snapshot) => snapshot.quotaBucketId !== bucketId)) {
    throw new Error("Cannot reconcile snapshots from more than one quota bucket");
  }

  const observations = [...snapshots];
  const sorted = [...observations].sort((a, b) => compareSnapshots(a, b, now.getTime()));
  const selected = sorted[0];
  const conflict = observations.some((left, leftIndex) =>
    observations.slice(leftIndex + 1).some((right) => observationsDisagree(left, right)),
  );

  return {
    bucketId,
    ...(selected === undefined ? {} : { selected }),
    observations,
    conflict,
    stale: selected === undefined ? true : isStale(selected, now.getTime()),
  };
}
