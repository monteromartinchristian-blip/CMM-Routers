import { describe, expect, it } from "vitest";
import type { QuotaBucket, QuotaSnapshot } from "../../../src/usage/domain/types.js";
import { AlertEngine } from "../../../src/usage/alerts/alert-engine.js";
import type { QuotaForecast } from "../../../src/usage/forecasting/quota-forecast.js";

function bucket(status: QuotaBucket["status"] = "healthy"): QuotaBucket {
  return {
    id: "bucket:test",
    accountId: "account:test",
    productId: "product:test",
    displayName: "Quota",
    metric: { kind: "requests" },
    windowPolicy: { kind: "provider_reported" },
    unit: "requests",
    enforcement: "hard",
    status,
    metadata: {},
  };
}

function snapshot(usedFraction: number): QuotaSnapshot {
  return {
    id: `snapshot:${usedFraction}`,
    quotaBucketId: "bucket:test",
    observedAt: "2026-09-13T12:00:00.000Z",
    usedFraction,
    remainingFraction: 1 - usedFraction,
    source: "provider_official_api",
    confidence: "exact",
    stalenessAfter: "2026-09-13T12:10:00.000Z",
  };
}

describe("AlertEngine", () => {
  it("marks >=75% known usage as warning by default", () => {
    const engine = new AlertEngine();
    const result = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.75),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("warning");
    expect(result.alert?.kind).toBe("usage_fraction");
  });

  it("marks >=90% known usage as critical by default", () => {
    const engine = new AlertEngine();
    const result = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.9),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("critical");
    expect(result.alert?.kind).toBe("usage_fraction");
  });

  it("marks predicted exhaustion before reset as critical", () => {
    const forecast: QuotaForecast = {
      bucketId: "bucket:test",
      unit: "requests",
      confidence: "calculated",
      burnRate: 2,
      sustainableRate: 1,
      paceRatio: 2,
      predictedExhaustionAt: "2026-09-13T12:30:00.000Z",
      willExhaustBeforeReset: true,
    };
    const engine = new AlertEngine();
    const result = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.5),
      forecast,
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("critical");
    expect(result.alert?.kind).toBe("predicted_exhaustion");
  });

  it("preserves provider-reported exhaustion as exhausted", () => {
    const engine = new AlertEngine();
    const result = engine.evaluate({
      bucket: bucket("exhausted"),
      snapshot: snapshot(1),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("exhausted");
    expect(result.alert?.kind).toBe("quota_exhausted");
  });

  it("keeps unknown quota state unknown when no stronger evidence exists", () => {
    const engine = new AlertEngine();
    const result = engine.evaluate({
      bucket: bucket("unknown"),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result).toEqual({ status: "unknown" });
  });

  it("deduplicates matching alerts during the cooldown window", () => {
    const engine = new AlertEngine({ cooldownMs: 60_000 });
    const first = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.91),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });
    const duplicate = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.92),
      now: new Date("2026-09-13T12:00:30.000Z"),
    });
    const afterCooldown = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.93),
      now: new Date("2026-09-13T12:01:01.000Z"),
    });

    expect(first.alert).toBeDefined();
    expect(duplicate.status).toBe("critical");
    expect(duplicate.alert).toBeUndefined();
    expect(afterCooldown.alert).toBeDefined();
  });

  it("supports provider-specific fraction thresholds", () => {
    const engine = new AlertEngine({ warningUsedFraction: 0.6, criticalUsedFraction: 0.8 });
    const result = engine.evaluate({
      bucket: bucket(),
      snapshot: snapshot(0.61),
      now: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(result.status).toBe("warning");
  });
});
