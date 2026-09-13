import type {
  AlertKind,
  QuotaBucket,
  QuotaSnapshot,
  QuotaStatus,
} from "../domain/types.js";
import type { QuotaForecast } from "../forecasting/quota-forecast.js";

export interface AlertEngineOptions {
  warningUsedFraction?: number;
  criticalUsedFraction?: number;
  cooldownMs?: number;
  thresholdsForBucket?: (bucket: QuotaBucket) => AlertThresholds | undefined;
}

export interface AlertThresholds {
  warningUsedFraction?: number;
  criticalUsedFraction?: number;
}

export interface QuotaAlert {
  bucketId: string;
  kind: AlertKind;
  status: QuotaStatus;
  triggeredAt: string;
}

export interface QuotaAlertEvaluation {
  status: QuotaStatus;
  alert?: QuotaAlert;
}

export interface EvaluateQuotaAlertInput {
  bucket: QuotaBucket;
  snapshot?: QuotaSnapshot;
  forecast?: QuotaForecast;
  now: Date;
}

interface AlertDecision {
  status: QuotaStatus;
  kind?: AlertKind;
}

export class AlertEngine {
  private readonly warningUsedFraction: number;
  private readonly criticalUsedFraction: number;
  private readonly cooldownMs: number;
  private readonly thresholdsForBucket?: AlertEngineOptions["thresholdsForBucket"];
  // Cooldown state is intentionally process-local. Durable alert history belongs to the persistence layer.
  private readonly lastEmittedAt = new Map<string, number>();

  constructor(options: AlertEngineOptions = {}) {
    this.warningUsedFraction = options.warningUsedFraction ?? 0.75;
    this.criticalUsedFraction = options.criticalUsedFraction ?? 0.9;
    this.cooldownMs = options.cooldownMs ?? 15 * 60_000;
    this.thresholdsForBucket = options.thresholdsForBucket;
  }

  private decide(input: EvaluateQuotaAlertInput): AlertDecision {
    if (input.bucket.status === "exhausted") {
      return { status: "exhausted", kind: "quota_exhausted" };
    }

    const fraction = input.snapshot?.usedFraction;
    const confidence = input.snapshot?.confidence;
    const fractionIsActionable = confidence === "exact" || confidence === "calculated";
    if (fraction === 1 && fractionIsActionable) {
      return { status: "exhausted", kind: "quota_exhausted" };
    }

    if (input.forecast?.willExhaustBeforeReset === true) {
      return { status: "critical", kind: "predicted_exhaustion" };
    }

    const override = this.thresholdsForBucket?.(input.bucket);
    const warningUsedFraction = override?.warningUsedFraction ?? this.warningUsedFraction;
    const criticalUsedFraction = override?.criticalUsedFraction ?? this.criticalUsedFraction;
    if (fraction !== undefined && fractionIsActionable) {
      if (fraction >= criticalUsedFraction) {
        return { status: "critical", kind: "usage_fraction" };
      }
      if (fraction >= warningUsedFraction) {
        return { status: "warning", kind: "usage_fraction" };
      }
    }

    if (input.bucket.status === "critical") return { status: "critical" };
    if (input.bucket.status === "warning") return { status: "warning" };
    if (input.bucket.status === "healthy") return { status: "healthy" };
    if (input.bucket.status === "unavailable") return { status: "unavailable" };
    return { status: "unknown" };
  }

  evaluate(input: EvaluateQuotaAlertInput): QuotaAlertEvaluation {
    if (input.snapshot !== undefined && input.snapshot.quotaBucketId !== input.bucket.id) {
      throw new Error(`Snapshot bucket ${input.snapshot.quotaBucketId} does not match ${input.bucket.id}`);
    }
    if (input.forecast !== undefined && input.forecast.bucketId !== input.bucket.id) {
      throw new Error(`Forecast bucket ${input.forecast.bucketId} does not match ${input.bucket.id}`);
    }
    if (input.forecast !== undefined && input.forecast.unit !== input.bucket.unit) {
      throw new Error(`Forecast unit ${input.forecast.unit} does not match bucket unit ${input.bucket.unit}`);
    }

    const decision = this.decide(input);
    if (decision.kind === undefined) return { status: decision.status };

    const dedupeKey = `${input.bucket.id}:${decision.status}:${decision.kind}`;
    const nowMs = input.now.getTime();
    const previous = this.lastEmittedAt.get(dedupeKey);
    if (previous !== undefined && nowMs - previous < this.cooldownMs) {
      return { status: decision.status };
    }

    this.lastEmittedAt.set(dedupeKey, nowMs);
    return {
      status: decision.status,
      alert: {
        bucketId: input.bucket.id,
        kind: decision.kind,
        status: decision.status,
        triggeredAt: input.now.toISOString(),
      },
    };
  }
}
