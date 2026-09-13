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
  private readonly lastEmittedAt = new Map<string, number>();

  constructor(options: AlertEngineOptions = {}) {
    this.warningUsedFraction = options.warningUsedFraction ?? 0.75;
    this.criticalUsedFraction = options.criticalUsedFraction ?? 0.9;
    this.cooldownMs = options.cooldownMs ?? 15 * 60_000;
  }

  private decide(input: EvaluateQuotaAlertInput): AlertDecision {
    if (input.bucket.status === "exhausted") {
      return { status: "exhausted", kind: "quota_exhausted" };
    }

    if (input.forecast?.willExhaustBeforeReset === true) {
      return { status: "critical", kind: "predicted_exhaustion" };
    }

    const fraction = input.snapshot?.usedFraction;
    const confidence = input.snapshot?.confidence;
    const fractionIsActionable = confidence === "exact" || confidence === "calculated";
    if (fraction !== undefined && fractionIsActionable) {
      if (fraction >= this.criticalUsedFraction) {
        return { status: "critical", kind: "usage_fraction" };
      }
      if (fraction >= this.warningUsedFraction) {
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
