import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../../../src/usage/domain/types.js";
import { reconcileQuotaSnapshots } from "../../../src/usage/reconciliation/reconciler.js";

const now = new Date("2026-09-13T12:00:00.000Z");

function snapshot(
  id: string,
  overrides: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return {
    id,
    quotaBucketId: "bucket:weekly",
    observedAt: "2026-09-13T11:55:00.000Z",
    remainingFraction: 0.5,
    source: "router_measured",
    confidence: "measured",
    stalenessAfter: "2026-09-13T12:05:00.000Z",
    ...overrides,
  };
}

describe("reconcileQuotaSnapshots", () => {
  it("prefers a fresh provider-authoritative exact value over a local estimate", () => {
    const official = snapshot("official", {
      remainingFraction: 0.42,
      source: "provider_official_api",
      confidence: "exact",
    });
    const estimate = snapshot("estimate", {
      remainingFraction: 0.4,
      source: "estimated",
      confidence: "estimated",
      observedAt: "2026-09-13T11:59:00.000Z",
    });

    const state = reconcileQuotaSnapshots([estimate, official], now);

    expect(state.selected?.id).toBe("official");
    expect(state.observations.map((value) => value.id).sort()).toEqual(["estimate", "official"]);
    expect(state.stale).toBe(false);
  });

  it("prefers fresh router measurement over stale authoritative data", () => {
    const staleOfficial = snapshot("stale-official", {
      remainingFraction: 0.8,
      source: "provider_official_api",
      confidence: "exact",
      observedAt: "2026-09-13T10:00:00.000Z",
      stalenessAfter: "2026-09-13T10:10:00.000Z",
    });
    const freshMeasured = snapshot("fresh-router", {
      remainingFraction: 0.55,
      source: "router_measured",
      confidence: "measured",
    });

    const state = reconcileQuotaSnapshots([staleOfficial, freshMeasured], now);

    expect(state.selected?.id).toBe("fresh-router");
    expect(state.stale).toBe(false);
  });

  it("retains exact and estimated conflicting observations for diagnostics", () => {
    const exact = snapshot("exact", {
      remainingValue: 70,
      limitValue: 100,
      remainingFraction: 0.7,
      source: "provider_official_api",
      confidence: "exact",
    });
    const estimated = snapshot("estimated", {
      remainingValue: 62,
      limitValue: 100,
      remainingFraction: 0.62,
      source: "estimated",
      confidence: "estimated",
    });

    const state = reconcileQuotaSnapshots([estimated, exact], now);

    expect(state.selected?.id).toBe("exact");
    expect(state.observations).toHaveLength(2);
    expect(state.conflict).toBe(true);
  });

  it("keeps percentage-only observations percentage-only", () => {
    const percentage = snapshot("percentage", {
      usedFraction: 0.73,
      remainingFraction: 0.27,
    });

    const state = reconcileQuotaSnapshots([percentage], now);

    expect(state.selected?.usedFraction).toBe(0.73);
    expect(state.selected?.remainingFraction).toBe(0.27);
    expect(state.selected?.limitValue).toBeUndefined();
    expect(state.selected?.usedValue).toBeUndefined();
    expect(state.selected?.remainingValue).toBeUndefined();
  });

  it("does not back-calculate an absolute limit from a percentage", () => {
    const percentage = snapshot("percentage", {
      remainingFraction: 0.25,
      usedFraction: 0.75,
    });

    const state = reconcileQuotaSnapshots([percentage], now);

    expect(state.selected).toEqual(percentage);
    expect(state.selected).not.toHaveProperty("limitValue");
  });

  it("refuses to reconcile snapshots from incompatible quota buckets", () => {
    expect(() =>
      reconcileQuotaSnapshots(
        [snapshot("a"), snapshot("b", { quotaBucketId: "bucket:currency" })],
        now,
      ),
    ).toThrow(/bucket/i);
  });

  it("reports stale when every retained observation is stale", () => {
    const state = reconcileQuotaSnapshots(
      [
        snapshot("stale", {
          stalenessAfter: "2026-09-13T11:59:00.000Z",
        }),
      ],
      now,
    );

    expect(state.selected?.id).toBe("stale");
    expect(state.stale).toBe(true);
  });
});
