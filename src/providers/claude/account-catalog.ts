/**
 * The concrete Claude models this subscription's own account catalog declares.
 *
 * The Agent SDK's quick-select list is deliberately small: it names the models
 * a session offers by default and resolves each to the canonical wire model it
 * serves. It is not the account catalog. A subscriber can select several
 * generations of the same family (Opus 5.5 and Opus 5 and Opus 4.x), and
 * presenting only the quick-select resolution would collapse a family into one
 * entry and hide every other generation the account can actually run.
 *
 * Every row below was read from this account's catalog and then confirmed by
 * invoking the model through the Router's own Claude profile: each callable row
 * answered, and `canonicalModel` echoed the exact id that was requested, so no
 * row here is an alias in disguise. Rows the account gates behind usage credits
 * are declared with `requiresUsageCredits` and are published as unavailable —
 * a model the account knows but will not serve is never presented as callable.
 *
 * This declaration is a supplement, never an override: what the runtime
 * resolves live always wins, and when the profile's own cached account catalog
 * is readable (the CLI writes one for interactive sessions) that file replaces
 * this table entirely. Bump {@link ACCOUNT_CATALOG_VERSION} whenever the rows
 * change so a reader can tell which declaration it is looking at.
 */

import { readdirSync, readFileSync } from "node:fs";

export interface AccountCatalogEntry {
  /** The canonical wire model id, exactly as the account declares it. */
  id: string;
  /** Family name the account gives the model. */
  family: string;
  /** Version the account's own id spells out, when it spells one. */
  version?: string;
  /** Context window observed when this model was invoked. */
  contextWindow?: number;
  /** Effort levels the account declares for this model. */
  reasoningEfforts?: readonly string[];
  /** Whether the account declares adaptive thinking for this model. */
  adaptiveThinking?: boolean;
  /**
   * Set when the account restricts the model behind separately billed usage
   * credits. The model is known to the account and is still not callable.
   */
  requiresUsageCredits?: boolean;
}

export const ACCOUNT_CATALOG_VERSION = "2026-10-01";

export const ACCOUNT_CATALOG: readonly AccountCatalogEntry[] = [
  {
    id: "claude-opus-5-5",
    family: "Opus",
    version: "5.5",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-opus-5",
    family: "Opus",
    version: "5",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-opus-4-8",
    family: "Opus",
    version: "4.8",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-opus-4-7",
    family: "Opus",
    version: "4.7",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-opus-4-6",
    family: "Opus",
    version: "4.6",
    contextWindow: 200_000,
    reasoningEfforts: ["low", "medium", "high", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-sonnet-5-5",
    family: "Sonnet",
    version: "5.5",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-sonnet-5",
    family: "Sonnet",
    version: "5",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-sonnet-4-6",
    family: "Sonnet",
    version: "4.6",
    contextWindow: 200_000,
    reasoningEfforts: ["low", "medium", "high", "max"],
    adaptiveThinking: true,
  },
  {
    id: "claude-fable-5-1",
    family: "Fable",
    version: "5.1",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
    requiresUsageCredits: true,
  },
  {
    id: "claude-fable-5",
    family: "Fable",
    version: "5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    adaptiveThinking: true,
    requiresUsageCredits: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    family: "Haiku",
    version: "4.5",
    contextWindow: 200_000,
    adaptiveThinking: false,
  },
];

/**
 * The catalog the account's own CLI cached inside the Router's profile, when
 * one is readable. This is the account's own declaration and therefore wins
 * over {@link ACCOUNT_CATALOG} whenever it is present.
 *
 * Returns `undefined` when the profile has written no catalog, when the newest
 * file is unreadable, or when it declares no models — an absent catalog is an
 * honest unknown, never an empty answer.
 */
export function readProfileAccountCatalog(
  profileDir: string,
): readonly AccountCatalogEntry[] | undefined {
  let dir: string[];
  try {
    dir = readdirSync(`${profileDir}/cache/model-catalog`);
  } catch {
    return undefined;
  }
  const candidates = dir
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const raw = JSON.parse(
        readFileSync(`${profileDir}/cache/model-catalog/${name}`, "utf8"),
      ) as {
        catalog?: { config?: { models?: unknown[] } };
      };
      const models = raw?.catalog?.config?.models;
      if (!Array.isArray(models) || models.length === 0) continue;
      const entries: AccountCatalogEntry[] = [];
      for (const model of models) {
        const record = model as Record<string, unknown>;
        const id = record?.["id"];
        if (typeof id !== "string" || !id.startsWith("claude-")) continue;
        const name2 = typeof record["name"] === "string" ? (record["name"] as string) : id;
        const family = name2.split(" ")[0] ?? id;
        const version = name2.split(" ").slice(1).join(" ") || undefined;
        const thinking = record["thinking"] as
          | { type?: string; effort_options?: { id?: string }[] }
          | undefined;
        const efforts = (thinking?.effort_options ?? [])
          .map((option) => option?.id)
          .filter((level): level is string => typeof level === "string");
        const badge = record["badge"] as { message?: string } | undefined;
        entries.push({
          id,
          family,
          ...(version !== undefined ? { version } : {}),
          ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
          ...(thinking?.type === "effort"
            ? { adaptiveThinking: true }
            : { adaptiveThinking: false }),
          ...(typeof badge?.message === "string" && /credit/i.test(badge.message)
            ? { requiresUsageCredits: true }
            : {}),
        });
      }
      if (entries.length > 0) return withKnownContextWindows(entries);
    } catch {
      // A malformed cache file is skipped; the next candidate is tried.
    }
  }
  return undefined;
}
/**
 * Fill in the context window each model's observed invocations established.
 *
 * The account catalog states identity, naming, effort and account restrictions;
 * it does not state a context window. The windows below were read from the
 * `contextWindow` each model reported when it was actually invoked through this
 * profile, so they are observations of this account's models rather than a
 * table of what is "currently" largest. A model the account adds later keeps
 * whatever its own invocations report instead of inheriting one of these.
 */
function withKnownContextWindows(
  entries: readonly AccountCatalogEntry[],
): readonly AccountCatalogEntry[] {
  const observed = new Map(ACCOUNT_CATALOG.map((entry) => [entry.id, entry.contextWindow]));
  return entries.map((entry) => {
    const known = observed.get(entry.id);
    return entry.contextWindow === undefined && known !== undefined
      ? { ...entry, contextWindow: known }
      : entry;
  });
}
