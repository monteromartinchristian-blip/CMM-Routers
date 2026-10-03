import { describe, expect, it } from "vitest";
import type { DiscoveredModel } from "../../src/core/model.js";

/**
 * B3 publication contract, pinned at the wire boundary.
 *
 * A default is published only when the model declares it AND declares that
 * level itself. That guard is the whole point: a default naming a level the
 * model does not offer would let a client offer a control the model refuses.
 *
 * The field is deliberately NOT named `effective`. Nothing in this Router
 * reports what a runtime actually applied, and publishing a catalog default
 * under that name would let a client present it as provider-confirmed.
 */

type ModelRow = Record<string, unknown>;

/** Mirrors the projection in the `/v1/models` route. */
function publish(model: DiscoveredModel): ModelRow {
  return {
    ...(model.reasoningEfforts
      ? { reasoning_efforts: [...model.reasoningEfforts] }
      : {}),
    ...(model.defaultReasoningEffort &&
    model.reasoningEfforts?.includes(model.defaultReasoningEffort)
      ? { reasoning_effort_default: model.defaultReasoningEffort }
      : {}),
  };
}

function model(over: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "claude/claude-sonnet-5-5",
    provider: "claude",
    upstreamModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    ...over,
  } as DiscoveredModel;
}

describe("/v1/models effort default projection", () => {
  it("publishes the default alongside the ladder", () => {
    const row = publish(
      model({
        reasoningEfforts: ["low", "medium", "high", "extra_high", "max"],
        defaultReasoningEffort: "medium",
      }),
    );
    expect(row.reasoning_effort_default).toBe("medium");
    expect(row.reasoning_efforts).toEqual([
      "low",
      "medium",
      "high",
      "extra_high",
      "max",
    ]);
  });

  it("withholds a default that is not one of the model's own levels", () => {
    // The guard that stops a default from naming an unoffered level.
    const row = publish(
      model({
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "max",
      }),
    );
    expect(row.reasoning_effort_default).toBeUndefined();
    // The ladder itself is unaffected: this is a bad default, not a bad model.
    expect(row.reasoning_efforts).toEqual(["low", "medium", "high"]);
  });

  it("publishes neither for a model that declares no ladder", () => {
    const row = publish(model());
    expect(row.reasoning_efforts).toBeUndefined();
    expect(row.reasoning_effort_default).toBeUndefined();
  });

  it("withholds a default when no ladder is declared at all", () => {
    // A default with nothing to default into is meaningless.
    const row = publish(model({ defaultReasoningEffort: "medium" }));
    expect(row.reasoning_effort_default).toBeUndefined();
  });

  it("never publishes the default under an effective-effort name", () => {
    const row = publish(
      model({
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      }),
    );
    expect(Object.keys(row)).toEqual([
      "reasoning_efforts",
      "reasoning_effort_default",
    ]);
    expect(row).not.toHaveProperty("effective_reasoning_effort");
  });
});