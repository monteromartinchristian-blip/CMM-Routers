import { describe, expect, it } from "vitest";
import type { QuotaBucket, QuotaSnapshot } from "../../../src/usage/domain/types.js";
import { forecastQuota } from "../../../src/usage/forecasting/quota-forecast.js";

const now = new Date("2026-09-13T12:00:00.000Z");

function bucket(overrides: Partial<QuotaBucket> = {}): QuotaBucket {
  return {
    id: "bucket:requests",
    accountId: "account:test",
    productId: "product:test",
    displayName: "Requests",
    metric: { kind: "requests" },
    windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
    limitValue: 100,
    unit: "requests",
    enforcement: "hard",
    status: "healthy",
    metadata: {},
    ...overrides,
  };
}

function point(
  id: string,
  observedAt: string,
  usedValue: number,
  remainingValue: number,
  resetAt = "2026-09-13T13:00:00.000Z",
): QuotaSnapshot {
  return {
    id,
    quotaBucketId: "bucket:requests",
    observedAt,
    usedValue,
    remainingValue,
    limitValue: 100,
    usedFraction: usedValue / 100,
    remainingFraction: remainingValue / 100,
    resetAt,
    source: "provider_official_api",
    confidence: "exact",
    stalenessAfter: "2026-09-13T12:10:00.000Z",
  };
}

describe("forecastQuota", () => {
  it("calculates native-unit burn rate with enough history", () => {
    const result = forecastQuota(
      bucket(),
      [
        point("a", "2026-09-13T11:40:00.000Z", 20, 80),
        point("b", "2026-09-13T12:00:00.000Z", 40, 60),
      ],
      now,
    );

    expect(result.confidence).toBe("calculated");
    expect(result.unit).toBe("requests");
    expect(result.burnRate).toBeCloseTo(1 / 60, 8);
  });

  it("calculates sustainable rate, pace ratio and exhaustion before reset", () => {
    const result = forecastQuota(
      bucket(),
      [
        point("a", "2026-09-13T11:40:00.000Z", 20, 80),
        point("b", "2026-09-13T12:00:00.000Z", 40, 60),
      ],
      now,
    );

    expect(result.sustainableRate).toBeCloseTo(1 / 60, 8);
    expect(result.paceRatio).toBeCloseTo(1, 8);
    expect(result.predictedExhaustionAt).toBe("2026-09-13T13:00:00.000Z");
    expect(result.willExhaustBeforeReset).toBe(false);
  });

  it("predicts exhaustion before reset when burn rate exceeds sustainable rate", () => {
    const result = forecastQuota(
      bucket(),
      [
        point("a", "2026-09-13T11:50:00.000Z", 20, 80),
        point("b", "2026-09-13T12:00:00.000Z", 40, 60),
      ],
      now,
    );

    expect(result.paceRatio).toBeGreaterThan(1);
    expect(result.predictedExhaustionAt).toBe("2026-09-13T12:30:00.000Z");
    expect(result.willExhaustBeforeReset).toBe(true);
  });

  it("does not blend samples across a reset boundary", () => {
    const result = forecastQuota(
      bucket(),
      [
        point(
          "previous-window",
          "2026-09-13T10:00:00.000Z",
          95,
          5,
          "2026-09-13T11:00:00.000Z",
        ),
        point("current-window", "2026-09-13T12:00:00.000Z", 10, 90),
      ],
      now,
    );

    expect(result.confidence).toBe("unknown");
    expect(result.burnRate).toBeUndefined();
  });

  it("returns unknown when history is insufficient", () => {
    const result = forecastQuota(
      bucket(),
      [point("only", "2026-09-13T12:00:00.000Z", 40, 60)],
      now,
    );

    expect(result).toEqual({
      bucketId: "bucket:requests",
      unit: "requests",
      confidence: "unknown",
    });
  });

  it("keeps percentage forecasts in fractions rather than converting them to absolute units", () => {
    const percentageBucket = bucket({
      id: "bucket:percentage",
      metric: { kind: "percentage" },
      unit: "fraction",
      limitValue: undefined as never,
    });
    const percentagePoints: QuotaSnapshot[] = [
      {
        id: "p1",
        quotaBucketId: percentageBucket.id,
        observedAt: "2026-09-13T11:40:00.000Z",
        usedFraction: 0.2,
        remainingFraction: 0.8,
        resetAt: "2026-09-13T13:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter: "2026-09-13T12:10:00.000Z",
      },
      {
        id: "p2",
        quotaBucketId: percentageBucket.id,
        observedAt: "2026-09-13T12:00:00.000Z",
        usedFraction: 0.4,
        remainingFraction: 0.6,
        resetAt: "2026-09-13T13:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter: "2026-09-13T12:10:00.000Z",
      },
    ];

    const result = forecastQuota(percentageBucket, percentagePoints, now);

    expect(result.unit).toBe("fraction");
    expect(result.burnRate).toBeCloseTo(1 / 6000, 10);
  });

  it("refuses snapshots from another bucket instead of cross-aggregating units", () => {
    expect(() =>
      forecastQuota(
        bucket(),
        [
          point("a", "2026-09-13T11:40:00.000Z", 20, 80),
          { ...point("b", "2026-09-13T12:00:00.000Z", 40, 60), quotaBucketId: "bucket:usd" },
        ],
        now,
      ),
    ).toThrow(/bucket/i);
  });

  it("returns unknown instead of mixing absolute values and fractions in one native-unit series", () => {
    const mixed: QuotaSnapshot[] = [
      point("absolute", "2026-09-13T11:40:00.000Z", 20, 80),
      {
        id: "fraction-only",
        quotaBucketId: "bucket:requests",
        observedAt: "2026-09-13T12:00:00.000Z",
        usedFraction: 0.4,
        remainingFraction: 0.6,
        resetAt: "2026-09-13T13:00:00.000Z",
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter: "2026-09-13T12:10:00.000Z",
      },
    ];

    expect(forecastQuota(bucket(), mixed, now).confidence).toBe("unknown");
  });

  it("anchors exhaustion to the latest observation rather than query time", () => {
    const result = forecastQuota(
      bucket(),
      [
        point("a", "2026-09-13T11:50:00.000Z", 20, 80),
        point("b", "2026-09-13T11:55:00.000Z", 50, 50),
      ],
      now,
    );

    expect(result.predictedExhaustionAt).toBe("2026-09-13T12:03:20.000Z");
  });

  it("returns unknown when the latest reset is already in the past", () => {
    const result = forecastQuota(
      bucket(),
      [
        point("a", "2026-09-13T11:40:00.000Z", 20, 80, "2026-09-13T11:59:00.000Z"),
        point("b", "2026-09-13T11:55:00.000Z", 40, 60, "2026-09-13T11:59:00.000Z"),
      ],
      now,
    );

    expect(result.confidence).toBe("unknown");
  });

  it("returns unknown for resettable windows when the reset boundary is not known", () => {
    const withoutReset = [
      point("a", "2026-09-13T11:40:00.000Z", 20, 80),
      point("b", "2026-09-13T12:00:00.000Z", 40, 60),
    ].map(({ resetAt: _resetAt, ...snapshot }) => snapshot);

    expect(forecastQuota(bucket(), withoutReset, now).confidence).toBe("unknown");
  });

  it("propagates estimated input confidence conservatively", () => {
    const estimated = [
      { ...point("a", "2026-09-13T11:40:00.000Z", 20, 80), confidence: "estimated" as const },
      { ...point("b", "2026-09-13T12:00:00.000Z", 40, 60), confidence: "estimated" as const },
    ];

    expect(forecastQuota(bucket(), estimated, now).confidence).toBe("estimated");
  });
});
