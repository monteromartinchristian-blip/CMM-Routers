import { describe, expect, it } from "vitest";
import {
  codexEffortDeclaration,
  type CodexEffortDeclaration,
} from "../../src/providers/codex/effort-catalog.js";
import { REASONING_EFFORTS } from "../../src/core/model.js";

/**
 * B2/B3 contract, pinned.
 *
 * The Router is the sole publisher of which effort levels a concrete model
 * supports. These tests exist because the levels used to come from deployment
 * configuration, which made an environment variable a second, hidden source of
 * capability truth. Nothing here may be satisfied by a uniform rule: a model
 * absent from the catalog must publish no ladder at all.
 */

const DECLARED_IDS = [
  "chatgpt/gpt-5.5",
  "chatgpt/gpt-5.6-luna",
  "chatgpt/gpt-5.6-sol",
  "chatgpt/gpt-5.6-terra",
  "chatgpt/gpt-6-astra",
  "chatgpt/gpt-6-luna",
  "chatgpt/gpt-6-sol",
  "chatgpt/gpt-6.1-sol",
];

describe("codex effort catalog", () => {
  it("publishes a ladder for every declared ChatGPT model", () => {
    for (const id of DECLARED_IDS) {
      const declaration = codexEffortDeclaration(id);
      expect(declaration, `${id} must declare a ladder`).toBeDefined();
      expect(declaration!.reasoningEfforts.length).toBeGreaterThan(0);
    }
  });

  it("publishes NO ladder for a model it does not declare", () => {
    // gpt-daybreak-blue-latest is discovered by this lane but declares no
    // effort truth. It must not inherit a neighbour's ladder, which is exactly
    // the behaviour a family-level default rule would introduce.
    expect(codexEffortDeclaration("chatgpt/gpt-daybreak-blue-latest")).toBeUndefined();
    expect(codexEffortDeclaration("chatgpt/never-heard-of-it")).toBeUndefined();
  });

  it("only uses levels from the Router's canonical vocabulary", () => {
    for (const id of DECLARED_IDS) {
      for (const level of codexEffortDeclaration(id)!.reasoningEfforts) {
        expect(
          (REASONING_EFFORTS as readonly string[]).includes(level),
          `${id} declares ${level}, which is not canonical`,
        ).toBe(true);
      }
    }
  });

  it("publishes a default that is one of that same model's levels", () => {
    for (const id of DECLARED_IDS) {
      const declaration = codexEffortDeclaration(id)!;
      expect(declaration.defaultReasoningEffort, `${id} must publish a default`)
        .toBeDefined();
      expect(declaration.reasoningEfforts).toContain(
        declaration.defaultReasoningEffort,
      );
    }
  });

  it("has no default for a model that declares no ladder", () => {
    // Nothing to default to when nothing is offered.
    const absent = codexEffortDeclaration("chatgpt/gpt-daybreak-blue-latest");
    expect(absent).toBeUndefined();
    expect((absent as CodexEffortDeclaration | undefined)?.defaultReasoningEffort)
      .toBeUndefined();
  });

  it("declares models individually, so a divergent ladder needs no code shape change", () => {
    // Two models sharing a ladder today must remain independently addressable:
    // if the catalog collapsed to a family rule, a future model with fewer
    // levels could not say so. Distinct key lookup is the property that
    // guarantees the catalog can grow uneven ladders.
    const a = codexEffortDeclaration("chatgpt/gpt-5.5");
    const b = codexEffortDeclaration("chatgpt/gpt-6-sol");
    expect(a).not.toBe(b);
    expect(a).toEqual(b); // same content today, still resolved per model
  });
});