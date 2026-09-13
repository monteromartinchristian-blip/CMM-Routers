import { describe, expect, it } from "vitest";
import { resolveRouteHealth } from "../../../src/usage/domain/quota-resolution.js";
import { quotaSnapshotSchema } from "../../../src/usage/domain/validation.js";
import { canonicalQuotaScenarios } from "../fixtures/quota-scenarios.js";

describe("resolveRouteHealth", () => {
  it("marks a route exhausted when any bound hard bucket is exhausted", () => {
    const state = resolveRouteHealth(canonicalQuotaScenarios.modelSpecificApi);

    expect(state.status).toBe("exhausted");
    expect(state.primaryConstraint?.bucketId).toBe("model-specific");
    expect(state.constraints).toHaveLength(2);
  });

  it("selects the earlier predicted exhaustion before provider priority", () => {
    const state = resolveRouteHealth(canonicalQuotaScenarios.commandCodeStyle);

    expect(state.status).toBe("critical");
    expect(state.primaryConstraint?.bucketId).toBe("command-short");
  });

  it("does not manufacture one aggregate availability percentage", () => {
    const state = resolveRouteHealth(canonicalQuotaScenarios.openAiStyle);

    expect(state.status).toBe("critical");
    expect(state.primaryConstraint?.bucketId).toBe("openai-currency");
    expect(state).not.toHaveProperty("aggregateAvailabilityPercent");
  });

  it("keeps the same model identity independent across access routes", () => {
    const [anthropicRoute, googleRoute] = canonicalQuotaScenarios.claudeStyle.routes;

    expect(anthropicRoute.modelIdentityId).toBe(googleRoute.modelIdentityId);
    expect(anthropicRoute.id).not.toBe(googleRoute.id);
  });

  it("ignores inactive bindings when resolving route pressure", () => {
    const scenario = canonicalQuotaScenarios.modelSpecificApi;
    const state = resolveRouteHealth({
      ...scenario,
      bindings: scenario.bindings.map((value) =>
        value.quotaBucketId === "model-specific"
          ? { ...value, activeTo: "2026-09-13T11:59:59.000Z" }
          : value,
      ),
    });

    expect(state.status).toBe("healthy");
    expect(state.constraints.map((value) => value.bucketId)).toEqual(["shared-plan"]);
  });

  it("reports route unavailability independently of quota state", () => {
    const scenario = canonicalQuotaScenarios.modelSpecificApi;
    const state = resolveRouteHealth({
      ...scenario,
      accessRoute: { ...scenario.accessRoute, status: "unavailable" },
    });

    expect(state.status).toBe("unavailable");
  });
});

describe("quota domain validation", () => {
  it("rejects impossible quota fractions", () => {
    const valid = canonicalQuotaScenarios.percentageOnly.quotaStates[0]?.snapshot;
    expect(valid).toBeDefined();

    const parsed = quotaSnapshotSchema.safeParse({
      ...valid,
      remainingFraction: 1.25,
    });

    expect(parsed.success).toBe(false);
  });
});
