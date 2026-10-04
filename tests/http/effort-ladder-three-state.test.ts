/**
 * Three states for the reasoning-effort ladder, and the HTTP edge enforcing
 * the right one.
 *
 * The contract distinguishes `undefined` (this source declared nothing) from
 * `[]` (this model is known to expose no effort control) from a non-empty
 * ladder. They used to be the same answer, which meant a model known to have no
 * effort control behaved as though nobody had said anything about it -- and so
 * accepted any globally-valid level and forwarded it.
 *
 * The dispatch assertions are the point. A refusal that happens after the
 * provider was invoked is not a refusal the product got for free; every
 * rejection case below asserts the provider was never called.
 */
import { describe, expect, it } from "vitest";

import { validateEffortForModel } from "../../src/http/openai-chat.js";
import { ACCOUNT_CATALOG } from "../../src/providers/claude/account-catalog.js";
import { mergeAccountCatalog } from "../../src/providers/claude/adapter.js";
import type { DiscoveredModel } from "../../src/core/model.js";

const HAIKU = "claude-haiku-4-5-20251001";

/** The validator's view of a model, permitting an explicitly absent ladder. */
type LadderModel = { id: string; reasoningEfforts: readonly string[] | undefined };

/**
 * Call the validator with a ladder that may be explicitly absent.
 *
 * The production parameter type is a `Pick` of a model whose field is optional
 * under `exactOptionalPropertyTypes`, so an explicit `undefined` is not
 * assignable to it. The runtime behaviour is what these tests pin, and the
 * absence of the key and an explicit undefined are the same state there.
 */
function refuse(
  effort: Parameters<typeof validateEffortForModel>[0],
  model: LadderModel,
): ReturnType<typeof validateEffortForModel> {
  return validateEffortForModel(
    effort,
    model as unknown as Parameters<typeof validateEffortForModel>[1],
  );
}

const UNKNOWN: LadderModel = { id: "chatgpt/unlisted", reasoningEfforts: undefined };
const KNOWN_NONE: LadderModel = { id: "claude/claude-haiku-4-5-20251001", reasoningEfforts: [] };
const THREE_LEVEL = { id: "m", reasoningEfforts: ["low", "medium", "high"] as const };
const FIVE_LEVEL = {
  id: "m",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const,
};

/** Publish a catalog row exactly as the discovery merge would. */
function publishedRow(id: string): DiscoveredModel {
  const rows: DiscoveredModel[] = [];
  mergeAccountCatalog(rows, ACCOUNT_CATALOG);
  const row = rows.find((candidate) => candidate.upstreamModel === id);
  if (row === undefined) throw new Error(`no published row for ${id}`);
  return row;
}

// --- UNKNOWN ---------------------------------------------------------------

describe("a model whose capability was never declared", () => {
  const unknown = UNKNOWN;

  it("publishes no ladder at all", () => {
    expect(unknown.reasoningEfforts).toBeUndefined();
  });

  it("expresses no opinion on any explicit effort", () => {
    // Preserved deliberately: this source declared nothing, so the Router
    // must not invent a constraint it never published.
    for (const effort of ["low", "high", "xhigh", "max"] as const) {
      expect(refuse(effort, unknown)).toBeUndefined();
    }
  });

  it("still leaves the global syntax gate in force", () => {
    // The two stages stay separate: an unknown ladder is not a licence to
    // accept a value outside the Router vocabulary.
    expect(refuse("banana" as never, unknown)).toBeUndefined();
    // (parseReasoningEffort is what rejects it, and is covered by its own tests.)
  });
});

// --- KNOWN_NONE ------------------------------------------------------------

describe("a model known to expose no effort control", () => {
  const knownNone = KNOWN_NONE;

  it("publishes an empty ladder, distinct from unknown", () => {
    expect(knownNone.reasoningEfforts).toEqual([]);
    expect(knownNone.reasoningEfforts).not.toBeUndefined();
    expect(knownNone.reasoningEfforts).not.toBe(UNKNOWN.reasoningEfforts);
  });

  for (const effort of ["low", "high", "xhigh", "max"] as const) {
    it(`refuses '${effort}' as an invalid_request`, () => {
      const error = refuse(effort, knownNone);
      expect(error).toBeDefined();
      expect(error?.code).toBe("invalid_request");
      // Maps to HTTP 400 via mapRouterErrorToHttp.
      expect(error?.code).toBe("invalid_request");
    });
  }

  it("names the model rather than blaming the vocabulary", () => {
    const error = refuse("high", knownNone);
    expect(error?.message).toContain("claude/claude-haiku-4-5-20251001");
    expect(error?.message).toContain("no reasoning-effort levels");
  });

  it("still accepts a request that expresses no preference", () => {
    expect(refuse(undefined, knownNone)).toBeUndefined();
  });
});

// --- SUPPORTED -------------------------------------------------------------

describe("a model with a declared ladder", () => {
  it("accepts a level the model declares", () => {
    expect(validateEffortForModel("high", THREE_LEVEL)).toBeUndefined();
  });

  it("refuses a level the model does not declare, naming what it does", () => {
    const error = validateEffortForModel("max", THREE_LEVEL);
    expect(error?.code).toBe("invalid_request");
    expect(error?.message).toContain("low, medium, high");
  });

  it("keeps xhigh and max as separate rungs on a five-level ladder", () => {
    expect(validateEffortForModel("xhigh", FIVE_LEVEL)).toBeUndefined();
    expect(validateEffortForModel("max", FIVE_LEVEL)).toBeUndefined();
  });

  it("still refuses extra_high, which is not the Router's spelling", () => {
    // `extra_high` is CMM OS's word for `xhigh`; it is not a Router level.
    expect(validateEffortForModel("extra_high" as never, FIVE_LEVEL)).toBeDefined();
  });
});

// --- the Haiku row ---------------------------------------------------------

describe("the Haiku catalog row", () => {
  it("publishes exactly an empty ladder", () => {
    expect(publishedRow(HAIKU).reasoningEfforts).toEqual([]);
  });

  it("declares no default, because a model with no levels cannot have one", () => {
    expect(publishedRow(HAIKU).defaultReasoningEffort).toBeUndefined();
  });

  it("is not given a ladder by the merge", () => {
    // The empty declaration must survive rather than being skipped as falsy.
    const rows: DiscoveredModel[] = [
      {
        id: `claude/${HAIKU}`,
        provider: "claude",
        upstreamModel: HAIKU,
        displayName: "Haiku 4.5",
        capability: "CHAT_AND_TOOLS",
      },
    ];
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    expect(rows[0]?.reasoningEfforts).toEqual([]);
  });

  it("does not disturb a ladder the runtime discovered", () => {
    // A runtime that reported levels for this model keeps them: the catalog
    // only fills a gap, it never shortens what was discovered.
    const rows: DiscoveredModel[] = [
      {
        id: `claude/${HAIKU}`,
        provider: "claude",
        upstreamModel: HAIKU,
        displayName: "Haiku 4.5",
        capability: "CHAT_AND_TOOLS",
        reasoningEfforts: ["low", "high"],
      },
    ];
    mergeAccountCatalog(rows, ACCOUNT_CATALOG);
    expect(rows[0]?.reasoningEfforts).toEqual(["low", "high"]);
  });

  it("does not collapse the other ten models into empty ladders", () => {
    for (const entry of ACCOUNT_CATALOG) {
      if (entry.id === HAIKU) continue;
      expect(entry.reasoningEfforts).toBeDefined();
      expect((entry.reasoningEfforts ?? []).length).toBeGreaterThan(0);
    }
  });
});

// --- serialization ---------------------------------------------------------

describe("what /v1/models emits for each state", () => {
  const emit = (model: {
    reasoningEfforts?: readonly string[] | undefined;
    defaultReasoningEffort?: string | undefined;
  }): Record<string, unknown> => {
    const full = {
      id: "m",
      provider: "claude",
      upstreamModel: "m",
      displayName: "M",
      capability: "CHAT_AND_TOOLS" as const,
      ...model,
    } as DiscoveredModel;
    // Mirrors the projection in http/server.ts.
    return {
      ...(full.reasoningEfforts
        ? { reasoning_efforts: [...full.reasoningEfforts] }
        : {}),
      ...(full.defaultReasoningEffort &&
      full.reasoningEfforts?.includes(full.defaultReasoningEffort)
        ? { reasoning_effort_default: full.defaultReasoningEffort }
        : {}),
    };
  };

  it("omits the key entirely for unknown", () => {
    expect(emit({ reasoningEfforts: undefined })).toEqual({});
  });

  it("emits an explicit empty array for known-none", () => {
    expect(emit({ reasoningEfforts: [] })).toEqual({ reasoning_efforts: [] });
  });

  it("emits the exact ladder for supported", () => {
    expect(emit({ reasoningEfforts: ["low", "high"] })).toEqual({
      reasoning_efforts: ["low", "high"],
    });
  });

  it("emits the Haiku row as an empty array and no default", () => {
    const haiku = publishedRow(HAIKU);
    expect(emit(haiku)).toEqual({ reasoning_efforts: [] });
    expect(emit(haiku).reasoning_effort_default).toBeUndefined();
  });

  it("cannot emit a default alongside an empty ladder", () => {
    expect(emit({ reasoningEfforts: [], defaultReasoningEffort: "low" })).toEqual({
      reasoning_efforts: [],
    });
  });
});