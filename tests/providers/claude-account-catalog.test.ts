/**
 * The Claude account catalog supplement.
 *
 * The quick-select list is small; the account can run several generations of
 * the same family. These tests lock that no generation is collapsed away, that
 * a model the account will not serve is never published as callable, and that
 * routing aliases are left exactly as the runtime published them.
 */
import { describe, expect, it } from "vitest";

import { mergeAccountCatalog } from "../../src/providers/claude/adapter.js";
import { ACCOUNT_CATALOG } from "../../src/providers/claude/account-catalog.js";
import type { DiscoveredModel } from "../../src/core/model.js";

function runtimeRows(): DiscoveredModel[] {
  return [
    {
      id: "claude/claude-opus-5",
      provider: "claude",
      upstreamModel: "claude-opus-5",
      displayName: "Opus 5",
      version: "5",
    },
    {
      id: "claude/opus",
      provider: "claude",
      upstreamModel: "opus",
      displayName: "Opus",
      isAlias: true,
    },
  ];
}

describe("mergeAccountCatalog", () => {
  it("adds every concrete generation the account declares", () => {
    const rows = runtimeRows();
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    const concrete = rows.filter((row) => row.isAlias !== true).map((row) => row.id);
    expect(concrete).toContain("claude/claude-opus-5-5");
    expect(concrete).toContain("claude/claude-opus-4-6");
    expect(concrete).toContain("claude/claude-sonnet-5-5");
    expect(concrete).toContain("claude/claude-sonnet-4-6");
    expect(concrete).toContain("claude/claude-haiku-4-5-20251001");
  });

  it("keeps a row the runtime resolved, and only fills what it did not declare", () => {
    const rows = runtimeRows();
    rows[0]!.reasoningEfforts = ["low", "medium"];
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    const opus5 = rows.find((row) => row.id === "claude/claude-opus-5");
    expect(opus5?.displayName).toBe("Opus 5");
    expect(opus5?.reasoningEfforts).toEqual(["low", "medium"]);
    expect(opus5?.contextWindow).toBe(1_000_000);
  });

  it("never publishes a credit-gated model as callable", () => {
    const rows = runtimeRows();
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    for (const row of rows) {
      if (row.upstreamModel.includes("fable")) {
        expect(row.availability).toBe("unavailable");
      }
    }
  });

  it("leaves routing aliases untouched", () => {
    const rows = runtimeRows();
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    const aliases = rows.filter((row) => row.isAlias === true);
    expect(aliases.map((row) => row.id)).toEqual(["claude/opus"]);
  });

  it("carries each model's own effort ladder, and an empty one where declared", () => {
    const rows = runtimeRows();
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    const haiku = rows.find((row) => row.upstreamModel === "claude-haiku-4-5-20251001");
    // An EMPTY ladder, not an absent one: the account positively states this
    // model exposes no effort control, which is a different claim from nobody
    // having said anything.
    expect(haiku?.reasoningEfforts).toEqual([]);
    expect(haiku?.adaptiveThinking).toBe(false);
    const opus46 = rows.find((row) => row.upstreamModel === "claude-opus-4-6");
    expect(opus46?.reasoningEfforts).toEqual(["low", "medium", "high", "max"]);
  });
});
describe("runtime requirements", () => {
  it("marks a model the bundled runtime is too old to serve as unavailable", () => {
    const rows: DiscoveredModel[] = [];
    mergeAccountCatalog(rows, [
      {
        id: "claude-opus-5-5",
        family: "Opus",
        version: "5.5",
        minRuntimeVersion: "99.0.0",
        unavailableReason: "Requires Claude Code 99.0.0 or newer",
      },
    ]);
    expect(rows[0]?.availability).toBe("unavailable");
    expect(rows[0]?.unavailableReason).toContain("99.0.0");
  });

  it("leaves a model the runtime can serve alone", () => {
    const rows: DiscoveredModel[] = [];
    mergeAccountCatalog(rows, [
      { id: "claude-opus-5-5", family: "Opus", version: "5.5", minRuntimeVersion: "1.0.0" },
    ]);
    expect(rows[0]?.availability).toBeUndefined();
  });
});
