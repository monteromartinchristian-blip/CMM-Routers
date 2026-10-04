/**
 * Catalog truth for the Claude lane.
 *
 * These tests exist because a curated table drifts from the account, and the
 * drift stays invisible until a user picks a level the model cannot honour.
 *
 * Every expectation below is a reading, not a preference. The ladders came
 * from this account's own catalog cache
 * (`~/.claude/cache/model-catalog/*.json`, `catalog.config.models[].thinking`)
 * and were corroborated by `supportedModels()` on the bundled 2.1.266 runtime
 * and on an isolated 2.1.288 runtime. The floors came from the same file's
 * `min_claude_code_version`, from a runtime-too-old refusal naming the version
 * it requires, and from which model each runtime's quick-select actually
 * resolves `opus` to.
 *
 * The vocabulary here is the Router's own: low, medium, high, xhigh, max.
 * `xhigh` is NOT a spelling of Hub/CMM OS `extra_high`; the translation
 * downstream is deliberate and lives in CMM OS, not here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ACCOUNT_CATALOG } from "../../src/providers/claude/account-catalog.js";
import { REASONING_EFFORTS } from "../../src/core/model.js";
import { mergeAccountCatalog } from "../../src/providers/claude/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS_5_5 = "claude-opus-5-5";

/** The account's own declaration for each model, read from its catalog file. */
const ACCOUNT_DECLARATION: Record<string, readonly string[] | undefined> = {
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  [HAIKU]: undefined,
};

function entry(id: string) {
  const found = ACCOUNT_CATALOG.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no catalog entry for ${id}`);
  return found;
}

/** The rows the Router would publish for a model the runtime also resolved. */
function published(id: string): DiscoveredModel {
  const rows: DiscoveredModel[] = [];
  mergeAccountCatalog(rows, ACCOUNT_CATALOG);
  const row = rows.find((candidate) => candidate.upstreamModel === id);
  if (row === undefined) throw new Error(`no published row for ${id}`);
  return row;
}

describe("a model the account declares without effort", () => {
  it("exposes no ladder, on both the declaration and the published row", () => {
    expect(entry(HAIKU).reasoningEfforts).toBeUndefined();
    expect(published(HAIKU).reasoningEfforts).toBeUndefined();
  });

  it("exposes no default", () => {
    expect(entry(HAIKU).defaultReasoningEffort).toBeUndefined();
    expect(published(HAIKU).defaultReasoningEffort).toBeUndefined();
  });

  it("matches the account, which declares thinking.type 'none' for it", () => {
    expect(ACCOUNT_DECLARATION[HAIKU]).toBeUndefined();
    expect(entry(HAIKU).reasoningEfforts).toEqual(ACCOUNT_DECLARATION[HAIKU]);
  });
});

describe("every declared ladder is the account's, not a house default", () => {
  it.each(Object.keys(ACCOUNT_DECLARATION))(
    "%s keeps exactly the ladder the account declares",
    (id) => {
      expect(entry(id).reasoningEfforts).toEqual(ACCOUNT_DECLARATION[id]);
    },
  );

  it("Opus 5.5 declares its exact discovered ladder, in order", () => {
    expect(entry(OPUS_5_5).reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps the models that lack xhigh without it", () => {
    expect(entry("claude-opus-4-6").reasoningEfforts).not.toContain("xhigh");
    expect(entry("claude-sonnet-4-6").reasoningEfforts).not.toContain("xhigh");
  });

  it("does not give every Claude model one identical ladder", () => {
    const shapes = new Set(
      ACCOUNT_CATALOG.map((candidate) =>
        (candidate.reasoningEfforts ?? []).join(","),
      ),
    );
    // Two shapes at least: the five-rung ladder and the four-rung one, plus
    // the model that declares none. A single shared ladder is the bug.
    expect(shapes.size).toBeGreaterThanOrEqual(3);
  });
});

describe("a default must name a level the same model offers", () => {
  it.each(ACCOUNT_CATALOG.map((candidate) => candidate.id))(
    "%s declares a default inside its own ladder",
    (id) => {
      const found = entry(id);
      if (found.defaultReasoningEffort === undefined) return;
      expect(found.reasoningEfforts).toBeDefined();
      expect(found.reasoningEfforts).toContain(found.defaultReasoningEffort);
    },
  );

  it("gives no default to a model with no ladder", () => {
    for (const candidate of ACCOUNT_CATALOG) {
      if (candidate.reasoningEfforts === undefined) {
        expect(candidate.defaultReasoningEffort).toBeUndefined();
      }
    }
  });
});

describe("no global Claude ladder exists", () => {
  it("never publishes one ladder for every Claude row", () => {
    const rows: DiscoveredModel[] = [];
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    const ladders = rows
      .filter((row) => row.isAlias !== true)
      .map((row) => (row.reasoningEfforts ?? []).join(","));
    expect(new Set(ladders).size).toBeGreaterThan(1);
    expect(ladders).toContain(""); // the no-effort model stays empty
  });

  it("keeps xhigh and max as separate rungs, never one spelling of the other", () => {
    const ladder = entry(OPUS_5_5).reasoningEfforts ?? [];
    expect(ladder).toContain("xhigh");
    expect(ladder).toContain("max");
    // The Router spells its own top rung `max`; `extra_high` is CMM OS's word
    // for `xhigh` and must never appear in this table.
    expect(ladder).not.toContain("extra_high");
    // They are distinct rungs, not one value under two names.
    expect(new Set(ladder).size).toBe(ladder.length);
  });

  it("uses only levels from the canonical Router vocabulary", () => {
    for (const candidate of ACCOUNT_CATALOG) {
      for (const level of candidate.reasoningEfforts ?? []) {
        expect(REASONING_EFFORTS).toContain(level);
      }
    }
  });
});

describe("the runtime requirement gates a model the bundled runtime is too old to serve", () => {
  // The floor is the account's own declaration, and the refusal that named it:
  // "Claude Code 2.1.266 does not support this model; version 2.1.280 or newer
  // is required". 2.1.266's quick-select does not resolve `opus` to Opus 5.5
  // at all, so a Router on 2.1.266 must not offer it.
  afterEach(() => vi.restoreAllMocks());

  async function withRuntime(version: string) {
    vi.resetModules();
    vi.doMock("../../src/providers/claude/runtime-version.js", () => ({
      claudeRuntimeVersion: () => version,
    }));
    const module = await import("../../src/providers/claude/account-catalog.js");
    // A profile directory with no catalog of its own, which is the state a
    // headless profile is actually in.
    return module.readAccountCatalogForRuntime(
      "/nonexistent-profile-for-this-test",
    );
  }

  it("marks Opus 5.5 unavailable on 2.1.266, with the version it requires", async () => {
    const catalog = await withRuntime("2.1.266");
    const opus = catalog.find((candidate) => candidate.id === OPUS_5_5);
    expect(opus).toBeDefined();
    expect(opus?.unavailableReason).toContain("2.1.280");
    expect(opus?.unavailableReason).toContain("2.1.266");
  });

  it("makes it eligible again on a compatible runtime", async () => {
    const catalog = await withRuntime("2.1.288");
    const opus = catalog.find((candidate) => candidate.id === OPUS_5_5);
    expect(opus?.unavailableReason).toBeUndefined();
  });

  it("keeps the model in the catalog either way: this is a runtime condition", async () => {
    const catalog = await withRuntime("2.1.266");
    expect(catalog.some((candidate) => candidate.id === OPUS_5_5)).toBe(true);
  });

  it("gates on the curated table too, not only on a profile's own catalog", async () => {
    // Regression: the gate used to run only inside readProfileAccountCatalog,
    // so a Router with no profile catalog -- the normal case -- published the
    // model as callable and failed at the first message instead.
    const catalog = await withRuntime("2.1.266");
    const gated = catalog.filter((candidate) => candidate.unavailableReason !== undefined);
    expect(gated.map((candidate) => candidate.id)).toContain(OPUS_5_5);
  });

  it("publishes an incompatible runtime's gated model as unavailable, not callable", () => {
    const rows: DiscoveredModel[] = [];
    mergeAccountCatalog(rows, [
      { ...entry(OPUS_5_5), unavailableReason: "Requires Claude Code 2.1.280 or newer; this runtime is 2.1.266" },
    ]);
    const row = rows.find((candidate) => candidate.upstreamModel === OPUS_5_5);
    expect(row?.availability).toBe("unavailable");
  });
});

describe("an entitlement is not a capability and not a runtime condition", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("models Fable's credit requirement as account state, never a floor", () => {
    for (const id of ["claude-fable-5-1", "claude-fable-5"]) {
      const found = entry(id);
      expect(found.requiresUsageCredits).toBe(true);
      // The same model serves an account that has credits. Encoding the credit
      // failure as a minimum runtime would make it permanent and wrong.
      expect(found.minRuntimeVersion).toBeUndefined();
    }
  });

  it("still declares Fable's ladder: credits gate the account, not the model", () => {
    expect(entry("claude-fable-5-1").reasoningEfforts).toEqual(
      ACCOUNT_DECLARATION["claude-fable-5-1"],
    );
  });

  it("gives a model with no credits requirement no such flag", () => {
    expect(entry(OPUS_5_5).requiresUsageCredits).toBeUndefined();
  });
});