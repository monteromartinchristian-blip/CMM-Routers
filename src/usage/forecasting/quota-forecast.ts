import type { Confidence, QuotaBucket, QuotaSnapshot } from "../domain/types.js";

export interface QuotaForecast {
  bucketId: string;
  unit: string;
  confidence: Confidence;
  burnRate?: number;
  sustainableRate?: number;
  paceRatio?: number;
  predictedExhaustionAt?: string;
  willExhaustBeforeReset?: boolean;
}

export interface ForecastQuotaOptions {
  minimumSamples?: number;
}

type MeasurementBasis = "absolute" | "fraction";

const confidenceRank: Record<Confidence, number> = {
  exact: 0,
  measured: 1,
  calculated: 2,
  estimated: 3,
  unknown: 4,
};

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function measurementBasis(bucket: QuotaBucket): MeasurementBasis {
  return bucket.unit === "fraction" || bucket.metric.kind === "percentage" ? "fraction" : "absolute";
}

function usedNative(snapshot: QuotaSnapshot, basis: MeasurementBasis): number | undefined {
  if (basis === "absolute") {
    if (snapshot.usedValue !== undefined) return snapshot.usedValue;
    if (snapshot.remainingValue !== undefined) return -snapshot.remainingValue;
    return undefined;
  }
  if (snapshot.usedFraction !== undefined) return snapshot.usedFraction;
  if (snapshot.remainingFraction !== undefined) return -snapshot.remainingFraction;
  return undefined;
}

function remainingNative(snapshot: QuotaSnapshot, basis: MeasurementBasis): number | undefined {
  return basis === "absolute" ? snapshot.remainingValue : snapshot.remainingFraction;
}

function forecastConfidence(snapshots: readonly QuotaSnapshot[]): Confidence {
  let result: Confidence = "calculated";
  for (const snapshot of snapshots) {
    if (confidenceRank[snapshot.confidence] > confidenceRank[result]) result = snapshot.confidence;
  }
  return result;
}

function unknown(bucket: QuotaBucket): QuotaForecast {
  return {
    bucketId: bucket.id,
    unit: bucket.unit,
    confidence: "unknown",
  };
}

export function forecastQuota(
  bucket: QuotaBucket,
  snapshots: readonly QuotaSnapshot[],
  now: Date,
  options: ForecastQuotaOptions = {},
): QuotaForecast {
  if (snapshots.some((snapshot) => snapshot.quotaBucketId !== bucket.id)) {
    throw new Error(`Cannot forecast quota ${bucket.id} using snapshots from another bucket`);
  }

  const minimumSamples = options.minimumSamples ?? 2;
  const ordered = [...snapshots].sort(
    (a, b) => (time(a.observedAt) ?? 0) - (time(b.observedAt) ?? 0),
  );
  const latest = ordered.at(-1);
  if (latest === undefined) return unknown(bucket);

  const latestFreshUntil = time(latest.stalenessAfter);
  if (latestFreshUntil !== undefined && latestFreshUntil <= now.getTime()) return unknown(bucket);

  const currentReset = latest.resetAt;
  if (bucket.windowPolicy.kind !== "none") {
    const resetTime = time(currentReset);
    if (resetTime === undefined || resetTime <= now.getTime()) return unknown(bucket);
  }

  const currentWindow = ordered.filter((snapshot) => snapshot.resetAt === currentReset);
  const basis = measurementBasis(bucket);
  const measurable = currentWindow.filter(
    (snapshot) => time(snapshot.observedAt) !== undefined && usedNative(snapshot, basis) !== undefined,
  );
  if (measurable.length < minimumSamples) return unknown(bucket);

  const first = measurable[0];
  const last = measurable.at(-1);
  if (first === undefined || last === undefined) return unknown(bucket);

  const firstTime = time(first.observedAt);
  const lastTime = time(last.observedAt);
  const firstUsed = usedNative(first, basis);
  const lastUsed = usedNative(last, basis);
  if (
    firstTime === undefined ||
    lastTime === undefined ||
    firstUsed === undefined ||
    lastUsed === undefined ||
    lastTime <= firstTime
  ) {
    return unknown(bucket);
  }

  const burnRate = (lastUsed - firstUsed) / ((lastTime - firstTime) / 1000);
  const confidence = forecastConfidence(measurable);
  if (confidence === "unknown") return unknown(bucket);
  const result: QuotaForecast = {
    bucketId: bucket.id,
    unit: bucket.unit,
    confidence,
    burnRate,
  };

  const remaining = remainingNative(last, basis);
  const resetAt = time(last.resetAt);
  const secondsToReset = resetAt === undefined ? undefined : (resetAt - lastTime) / 1000;

  if (remaining !== undefined && secondsToReset !== undefined && secondsToReset > 0) {
    const sustainableRate = remaining / secondsToReset;
    result.sustainableRate = sustainableRate;
    result.paceRatio = sustainableRate === 0 ? Number.POSITIVE_INFINITY : burnRate / sustainableRate;
  }

  if (remaining !== undefined && burnRate > 0) {
    const predictedMs = lastTime + (remaining / burnRate) * 1000;
    result.predictedExhaustionAt = new Date(predictedMs).toISOString();
    if (resetAt !== undefined) result.willExhaustBeforeReset = predictedMs < resetAt;
  }

  return result;
}
