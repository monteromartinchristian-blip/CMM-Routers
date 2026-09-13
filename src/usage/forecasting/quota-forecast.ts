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

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usedNative(snapshot: QuotaSnapshot): number | undefined {
  if (snapshot.usedValue !== undefined) return snapshot.usedValue;
  if (snapshot.remainingValue !== undefined) return -snapshot.remainingValue;
  if (snapshot.usedFraction !== undefined) return snapshot.usedFraction;
  if (snapshot.remainingFraction !== undefined) return -snapshot.remainingFraction;
  return undefined;
}

function remainingNative(snapshot: QuotaSnapshot): number | undefined {
  if (snapshot.remainingValue !== undefined) return snapshot.remainingValue;
  return snapshot.remainingFraction;
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
  const currentWindow = ordered.filter((snapshot) => snapshot.resetAt === currentReset);
  const measurable = currentWindow.filter(
    (snapshot) => time(snapshot.observedAt) !== undefined && usedNative(snapshot) !== undefined,
  );
  if (measurable.length < minimumSamples) return unknown(bucket);

  const first = measurable[0];
  const last = measurable.at(-1);
  if (first === undefined || last === undefined) return unknown(bucket);

  const firstTime = time(first.observedAt);
  const lastTime = time(last.observedAt);
  const firstUsed = usedNative(first);
  const lastUsed = usedNative(last);
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
  const result: QuotaForecast = {
    bucketId: bucket.id,
    unit: bucket.unit,
    confidence: "calculated",
    burnRate,
  };

  const remaining = remainingNative(latest);
  const resetAt = time(latest.resetAt);
  const secondsToReset = resetAt === undefined ? undefined : (resetAt - now.getTime()) / 1000;

  if (remaining !== undefined && secondsToReset !== undefined && secondsToReset > 0) {
    const sustainableRate = remaining / secondsToReset;
    result.sustainableRate = sustainableRate;
    result.paceRatio = sustainableRate === 0 ? Number.POSITIVE_INFINITY : burnRate / sustainableRate;
  }

  if (remaining !== undefined && burnRate > 0) {
    const predictedMs = now.getTime() + (remaining / burnRate) * 1000;
    result.predictedExhaustionAt = new Date(predictedMs).toISOString();
    if (resetAt !== undefined) result.willExhaustBeforeReset = predictedMs < resetAt;
  }

  return result;
}
