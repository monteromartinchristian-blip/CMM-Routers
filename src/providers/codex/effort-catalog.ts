/**
 * Per-model reasoning-effort truth for the ChatGPT (codex) lane.
 *
 * WHY THIS EXISTS. `model/list` on this lane returns only
 * `{id, model, displayName, description, hidden, isDefault}` — it publishes no
 * effort information at all. Until now the Router therefore advertised no
 * ladder for any ChatGPT model, and the levels a client was offered came from
 * deployment configuration instead. That made deployment config a second,
 * hidden source of capability truth: which levels exist, and for which models,
 * depended on an environment variable rather than on the catalog.
 *
 * THE RULE THIS FILE ENFORCES. The catalog is the sole source of truth for
 * which levels a concrete model supports. Every model is listed
 * INDIVIDUALLY. A model that is not listed has no ladder, and a model listed
 * here never inherits another model's — several ChatGPT models share a ladder
 * today, and the next one that does not must be able to say so without this
 * file changing shape. There is deliberately no family-level or default rule.
 *
 * PROVENANCE, stated plainly. These ladders were previously asserted by
 * deployment configuration. Moving them here makes the Router the publisher;
 * it does not upgrade an operator assertion into something the upstream
 * verified, and this lane's upstream still declares nothing. If a ChatGPT model
 * stops accepting a level here, the catalog is wrong and this file is the place
 * that has to change.
 */

/** One concrete ChatGPT model's published effort truth. */
export interface CodexEffortDeclaration {
  /** Effort levels this concrete model accepts, in ascending order. */
  readonly reasoningEfforts: readonly string[];
  /**
   * The level this model defaults to when a client expresses no preference.
   * Always one of `reasoningEfforts`. This is CMM catalog metadata, not a
   * provider-reported effective value.
   */
  readonly defaultReasoningEffort?: string;
}

/**
 * Keyed by the Router's own model id (`chatgpt/<upstream>`), because that is
 * what a client selects and what the catalog publishes. An id absent from this
 * map publishes no ladder at all.
 */
const CODEX_EFFORT_DECLARATIONS: Readonly<Record<string, CodexEffortDeclaration>> = {
  "chatgpt/gpt-5.5": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-5.6-luna": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-5.6-sol": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-5.6-terra": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-6-astra": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-6-luna": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-6-sol": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  "chatgpt/gpt-6.1-sol": {
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  // `gpt-daybreak-blue-latest` is intentionally ABSENT. Deployment config never
  // gave it a ladder, and an undeclared model must publish none rather than
  // inherit its neighbours'.
};

/**
 * The effort truth this concrete model publishes, or `undefined` when it
 * declares none. Returning `undefined` rather than a default ladder is the
 * whole point: an undeclared model has nothing honest to offer.
 */
export function codexEffortDeclaration(
  routerModelId: string,
): CodexEffortDeclaration | undefined {
  return CODEX_EFFORT_DECLARATIONS[routerModelId];
}