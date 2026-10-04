import { describe, expect, it } from "vitest";
import type { DiscoveredModel } from "../../src/core/model.js";
import { RouterError } from "../../src/core/errors.js";
import { parseReasoningEffort, validateEffortForModel } from "../../src/http/openai-chat.js";

/**
 * F2 contract: the selected concrete model is the authority on effort levels.
 *
 * THE DEFECT THIS FIXES. The Router published a truthful per-model ladder and
 * then accepted any globally-valid level for any model. Reproduced live:
 *
 *   POST /v1/chat/completions
 *     model=chatgpt/gpt-5.5  (published: low, medium, high)
 *     reasoning_effort=max
 *   -> HTTP 500 provider_protocol_error
 *
 * 500 was wrong twice over. The Router already knew the model did not offer
 * `max`, and a caller error is not a server fault. Now the request is refused
 * at the boundary with 400, before any provider dispatch.
 *
 * TWO GATES, IN ORDER. `parseReasoningEffort` is a syntax gate: the value must
 * be spelled correctly. `validateEffortForModel` is the concrete-model gate:
 * the selected model must actually offer it. The first must not replace the
 * second, and the second must not be skipped when the model is known.
 */

function model(over: Partial<DiscoveredModel> = {}): Pick<DiscoveredModel, "id" | "reasoningEfforts"> {
  return {
    id: "chatgpt/gpt-5.5",
    reasoningEfforts: ["low", "medium", "high"],
    ...over,
  };
}

/** A model with no `reasoningEfforts` key at all. */
function undeclaredModel(): Pick<DiscoveredModel, "id" | "reasoningEfforts"> {
  return { id: "chatgpt/gpt-daybreak-blue-latest" };
}

describe("concrete-model effort validation (F2)", () => {
  it("rejects a level outside the selected model's ladder", () => {
    // The exact reproduction, now refused rather than forwarded.
    const error = validateEffortForModel("max", model());
    expect(error).toBeInstanceOf(RouterError);
    expect(error).toHaveProperty("code", "invalid_request");
    expect(error!.message).toContain("max");
    expect(error!.message).toContain("chatgpt/gpt-5.5");
  });

  it("accepts every level the model does publish", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(validateEffortForModel(level, model())).toBeUndefined();
    }
  });

  it("maps the rejection to HTTP 400, not 500", () => {
    // A caller error must not surface as a server fault. This is the whole
    // behavioural difference between the defect and the fix.
    const error = validateEffortForModel("max", model());
    expect(error).toBeDefined();
    // `invalid_request` is the code `mapRouterErrorToHttp` maps to 400.
    expect(error!.code).toBe("invalid_request");
  });

  it("names the supported levels so the caller can correct itself", () => {
    const error = validateEffortForModel("xhigh", model())!;
    expect(error.meta).toMatchObject({
      model: "chatgpt/gpt-5.5",
      requested: "xhigh",
      supported: ["low", "medium", "high"],
    });
  });

  it("still rejects a value that is not in the global vocabulary at all", () => {
    // The syntax gate runs first and must survive: an unknown spelling is a
    // caller error regardless of which model was selected.
    const bogus = parseReasoningEffort("ludicrous");
    expect(bogus).toBeInstanceOf(RouterError);
    expect(bogus).toHaveProperty("code", "invalid_request");
  });

  it("accepts an omitted preference for any model", () => {
    // No explicit request means the model's own default governs, which is a
    // catalog decision rather than a caller assertion.
    expect(validateEffortForModel(undefined, model())).toBeUndefined();
  });

  it("leaves a model that declared nothing unconstrained", () => {
    // This is the property that keeps the fix from being wrong in the other
    // direction. The ChatGPT lane publishes no ladder at all today, and
    // `claude/*` rows before B3 publish none either. Refusing levels for a
    // model that expressed no opinion would invent a constraint the catalog
    // never published, and would break every such model outright.
    expect(validateEffortForModel("max", undeclaredModel())).toBeUndefined();
  });

  it("refuses a level for a model known to expose no effort control", () => {
    // The companion case, and the reason the two are separated. An empty
    // ladder is not "no opinion": it is the catalog stating that this model
    // has no effort control. Forwarding a level to such a model meant the
    // provider either ignored it or silently downgraded it.
    for (const effort of ["low", "max"] as const) {
      const error = validateEffortForModel(effort, model({ reasoningEfforts: [] }));
      expect(error?.code).toBe("invalid_request");
    }
    // A request that expresses no preference is still fine.
    expect(validateEffortForModel(undefined, model({ reasoningEfforts: [] }))).toBeUndefined();
  });

  it("does not conflate max with the rung above high", () => {
    // `xhigh` is this Router's spelling of the rung CMM OS and the Hub call
    // `extra_high`; the translation happens at that boundary, not here. What
    // matters in this file is that `max` and `xhigh` are DISTINCT rungs. A model
    // declaring one does not thereby accept the other; collapsing them would
    // let a client offer and persist a level the model never claimed.
    const xhighOnly = model({ reasoningEfforts: ["low", "medium", "high", "xhigh"] });
    expect(validateEffortForModel("xhigh", xhighOnly)).toBeUndefined();
    expect(validateEffortForModel("max", xhighOnly)).toBeDefined();

    const maxOnly = model({ reasoningEfforts: ["low", "medium", "high", "max"] });
    expect(validateEffortForModel("max", maxOnly)).toBeUndefined();
    expect(validateEffortForModel("xhigh", maxOnly)).toBeDefined();
  });

  it("validates per model, so two models on the same request shape differ", () => {
    // The defect was global validation; the property that fixes it is that
    // the answer depends on WHICH model was selected.
    const threeLevel = model();
    const fiveLevel = model({
      id: "claude/claude-sonnet-5-5",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(validateEffortForModel("max", threeLevel)).toBeDefined();
    expect(validateEffortForModel("max", fiveLevel)).toBeUndefined();
  });
});