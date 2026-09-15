import { describe, expect, it } from "vitest";
import type { QuotaBucket } from "../../../src/usage/domain/types.js";
import { projectQuotaSummary } from "../../../src/usage/presentation/quota-presentation.js";

describe("quota entitlement presentation", () => {
  it("projects claimable provider capacity without turning it into an active route constraint", () => {
    const bucket: QuotaBucket = {
      id: "bucket:kira:bonus",
      accountId: "account:kira",
      productId: "product:kira:free",
      displayName: "Check-in bonus",
      metric: { kind: "tokens" },
      windowPolicy: { kind: "none" },
      limitValue: 50_000_000,
      unit: "tokens",
      enforcement: "soft",
      status: "healthy",
      metadata: {
        scope: "shared_pool",
        entitlementState: "claimable",
        entitlementEligibility: "requires_auth",
        entitlementAmount: 50_000_000,
        entitlementUnit: "tokens",
        entitlementActionLabel: "Sign in to claim",
        entitlementSource: "provider_official_api",
        entitlementConfidence: "exact",
        entitlementObservedAt: "2026-09-15T00:00:00.000Z",
        entitlementValidUntil: "2026-09-30T23:59:59.000Z",
        entitlementAppliesToRouteIds: ["route:kira:qwen-38", "route:kira:qwen-37"],
      },
    };

    const summary = projectQuotaSummary({
      bucket,
      status: "healthy",
      stale: false,
      constraining: false,
      affectedRouteIds: [],
    });

    expect(summary).toMatchObject({
      constraining: false,
      entitlement: {
        state: "claimable",
        eligibility: "requires_auth",
        amount: 50_000_000,
        unit: "tokens",
        actionLabel: "Sign in to claim",
        source: "provider_official_api",
        confidence: "exact",
        observedAt: "2026-09-15T00:00:00.000Z",
        validUntil: "2026-09-30T23:59:59.000Z",
        appliesToRouteIds: ["route:kira:qwen-37", "route:kira:qwen-38"],
        requiresExplicitUserAction: true,
      },
    });
    expect(summary.affectedRouteIds).toBeUndefined();
  });
});
