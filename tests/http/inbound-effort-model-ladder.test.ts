import { describe, expect, it } from "vitest";
import { REASONING_EFFORTS, type DiscoveredModel } from "../../src/core/model.js";
import { parseReasoningEffort } from "../../src/http/openai-chat.js";
import { RouterError } from "../../src/core/errors.js";

/**
 * F2 contract defect, pinned so it cannot be silently forgotten.
 *
 * The Router publishes a truthful per-model ladder, and validates an inbound
 * `reasoning_effort` against the GLOBAL vocabulary. It never checks the level
 * against the SELECTED MODEL's ladder. So a client can ask for a level the
 * Router itself published as unsupported, and the request is forwarded to a
 * provider that cannot carry it.
 *
 * Reproduced live before this test existed:
 *   POST /v1/chat/completions
 *     model=chatgpt/gpt-5.5  (published: low, medium, high)
 *     reasoning_effort=max
 *   -> HTTP 500 provider_protocol_error
 *
 * 500 is the wrong answer. The request should be refused at the boundary with
 * 400, because the Router already knows the model does not offer the level.
 *
 * WHAT THIS TEST DOES AND DOES NOT CLAIM. It documents observed behaviour so
 * the defect is visible in the suite. It does NOT assert the desired behaviour
 * as passing, because fixing it requires request handling that overlaps the
 * antigravity stream's in-flight work; the fix lands in the integration lane.
 */

function model(over: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "chatgpt/gpt-5.5",
    provider: "chatgpt",
    upstreamModel: "gpt-5.5",
    displayName: "GPT-5.5",
    ...over,
  } as DiscoveredModel;
}

describe("inbound reasoning_effort vs the selected model's ladder (F2, open defect)", () => {
  it("accepts a level that is canonical but outside this model's ladder", () => {
    // `max` is in REASONING_EFFORTS, so parsing succeeds...
    const parsed = parseReasoningEffort("max");
    expect(parsed).toBe("max");

    // ...while the selected model publishes only low/medium/high.
    const selected = model({ reasoningEfforts: ["low", "medium", "high"] });
    expect(selected.reasoningEfforts).not.toContain("max");

    // Nothing between these two facts rejects the request. This is the defect.
    expect(REASONING_EFFORTS).toContain("max");
  });

  it("leaves the boundary with no way to distinguish the two cases", () => {
    // Both a supported and an unsupported level parse identically and
    // identically well-typed, so no downstream check on the parse result
    // alone can tell them apart. A fix must consult the resolved model.
    const supported = parseReasoningEffort("high");
    const unsupported = parseReasoningEffort("max");
    expect(typeof supported).toBe("string");
    expect(typeof unsupported).toBe("string");
  });

  it("still refuses a level that is not canonical at all", () => {
    // The existing global check is correct and must survive any per-model
    // validation added later: an unknown spelling is a caller error either way.
    const bogus = parseReasoningEffort("ludicrous");
    expect(bogus).toBeInstanceOf(RouterError);
    expect(bogus).toHaveProperty("code", "invalid_request");
  });

  it("keeps a model that declares no ladder unopinionated", () => {
    // The intended fix must NOT start rejecting levels for these models: a
    // model that published no ladder expressed no opinion, so refusing a level
    // here would be the Router inventing a constraint it never declared.
    const silent = model();
    expect(silent.reasoningEfforts).toBeUndefined();
    expect(parseReasoningEffort("max")).toBe("max");
  });
});