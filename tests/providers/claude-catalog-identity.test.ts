/**
 * Claude catalog identity: a routing alias is not a model.
 *
 * The SDK's quick-select list is made of aliases (`default`, `opus[1m]`,
 * `sonnet`, `haiku`) and each carries the canonical wire model it resolves to.
 * The catalog must carry the concrete model; the alias stays routable but is
 * flagged, so a client never offers `sonnet` as if it were a model.
 */
import { describe, expect, it } from "vitest";

import {
  claudeConcreteDisplayName,
  claudeDeclaredVersion,
  readClaudeContextVariant,
} from "../../src/providers/claude/adapter.js";

describe("readClaudeContextVariant", () => {
  it("lifts the declared context window out of the identity", () => {
    expect(readClaudeContextVariant("claude-opus-5[1m]")).toEqual({
      baseModel: "claude-opus-5",
      contextWindow: 1_000_000,
    });
  });

  it("leaves an id without a variant untouched", () => {
    expect(readClaudeContextVariant("claude-sonnet-5")).toEqual({
      baseModel: "claude-sonnet-5",
    });
  });
});

describe("claudeDeclaredVersion", () => {
  it("reads the version the upstream id spells out", () => {
    expect(claudeDeclaredVersion("claude-opus-5")).toBe("5");
    expect(claudeDeclaredVersion("claude-sonnet-4-6")).toBe("4.6");
  });

  it("drops the snapshot date a pinned id appends", () => {
    expect(claudeDeclaredVersion("claude-haiku-4-5-20251001")).toBe("4.5");
  });
});

describe("claudeConcreteDisplayName", () => {
  it("names the concrete model, never the alias or its variant", () => {
    expect(claudeConcreteDisplayName("claude-opus-5")).toBe("Opus 5");
    expect(claudeConcreteDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("yields nothing for an id that names no family", () => {
    expect(claudeConcreteDisplayName("something-else")).toBeUndefined();
  });
});

describe("ClaudeAdapter.discoverModels (live SDK)", () => {
  it("publishes a concrete model for every routing alias it advertises", async () => {
    const { ClaudeAdapter } = await import("../../src/providers/claude/adapter.js");
    const adapter = new ClaudeAdapter();
    const models = await adapter.discoverModels();

    const concrete = models.filter((model) => model.isAlias !== true);
    expect(concrete.length).toBeGreaterThan(0);

    // Every alias row the SDK advertises has its concrete model published too,
    // so a client can always hide the alias and still offer the model.
    for (const alias of models.filter((model) => model.isAlias === true)) {
      expect(concrete.some((model) => model.upstreamModel.length > 0)).toBe(true);
      expect(alias.upstreamModel).toBeTruthy();
    }

    for (const model of concrete) {
      expect(model.id.startsWith("claude/")).toBe(true);
      expect(model.upstreamModel).toMatch(/^claude-/);
      expect(model.isAlias).toBeUndefined();
    }
  }, 120_000);
});