# GPT-6 Astra Execution Brief — CMM Usage

## Mission

Implement **CMM Usage** inside the existing `CMM-Routers` repository.

CMM Usage is a universal, local-first observability system for AI APIs and subscriptions. It exists because real AI providers expose radically different consumption systems: shared pools, model-specific limits, overlapping rolling/weekly/monthly windows, balances, credits, weighted units, percentage-only limits, and multiple independent ways to access the same conceptual model.

The central product requirement is to model those systems naturally rather than hard-code today's providers.

The implementation should be robust enough for the user's daily use and clean enough to publish publicly after real-world validation.

## Authoritative documents

Read both completely before implementation:

```text
docs/superpowers/specs/2026-09-12-cmm-usage-design.md
docs/superpowers/plans/2026-09-12-cmm-usage-implementation-plan.md
```

The frozen design spec is product truth.

The implementation plan defines milestones, tests, and acceptance evidence, but it is not intended to suppress good engineering judgment. If the existing repository already has a stronger equivalent abstraction or different integration filename, integrate naturally rather than duplicating infrastructure.

## Product model to internalize

The key idea is:

```text
Provider
  -> Account
    -> Product / Subscription
      -> AccessRoute ---- ModelIdentity
           |
           +---- QuotaBinding ---- QuotaBucket
```

A model and a route are not the same thing.

A model can be reachable through several products/providers with different quotas.

A route can consume from several buckets at once.

A bucket can constrain several routes at once.

There is no requirement for quotas to form a tree.

Examples the design must express cleanly:

1. An API gives one model its own monthly quota.
2. Several free models share one common allowance.
3. Command Code has simultaneous plan/global, short-window, weekly, and sometimes model-specific constraints.
4. Google AI Pro can separate first-party model usage from external OpenAI/Anthropic usage and apply additional windows inside those groups.
5. Claude/OpenAI-style usage can be constrained simultaneously by short rolling windows and weekly limits.
6. A provider may expose only a remaining balance.
7. A provider may expose only percentages and reset times.
8. The user may add Devin or any future provider tomorrow, or cancel Claude, without requiring a schema redesign.

## What the user should experience

The user should be able to open one local interface and understand:

- what they have used;
- what remains;
- when each meaningful quota resets;
- which quota is actually constraining a given model/access route;
- whether current burn rate will exhaust it before reset;
- what the source/confidence/freshness of each number is;
- how usage/cost evolved historically;
- which subscriptions/accounts are active, paused, cancelled, or archived.

A route with several different quotas must show those quotas separately. Do not force incomparable metrics into a fake single percentage.

## Engineering freedom

You are expected to use your own judgment.

You may improve:
- module decomposition;
- algorithms;
- concurrency model;
- query design;
- indexing;
- cache strategy;
- internal TypeScript shapes;
- test utilities;
- SwiftUI composition;
- scheduling implementation;
- adapter ergonomics;

provided the frozen semantics and acceptance criteria remain true.

Do not spend effort preserving pseudocode for its own sake. Prefer the cleanest implementation that fits the existing codebase.

## Hard invariants

Only a small set of boundaries are intentionally non-negotiable:

1. Never persist prompts or completions in CMM Usage.
2. Never persist raw credentials/tokens/secrets in the usage database.
3. Never delete historical usage merely because a subscription/provider is disabled or cancelled.
4. Never present estimates as exact provider facts.
5. Never perform quota-consuming inference solely to discover usage/quota state.
6. Do not introduce automatic quota-aware rerouting in v1.
7. Do not break existing CMM Routers behavior.
8. Keep committed implementation, fixtures, examples, and docs safe for later public release.

If the repository/runtime makes one of these genuinely impossible, stop and present concrete evidence rather than silently weakening it.

## Execution approach

Start from the approved repository state and create:

```text
feature/cmm-usage
```

Inspect the repository before editing.

Use tests to drive each meaningful contract. Commit in coherent, reviewable slices.

Provider integrations must be based on the provider's current supported usage/quota mechanism at implementation time. Verify rather than guess. The domain model is frozen; endpoint details are not.

When a provider exposes less information than desired, represent the missing information honestly as unknown. A partially informative adapter is preferable to invented precision.

## Provider extensibility

A new provider must not require editing the quota engine.

Support these integration paths:

- Manual Subscription/API adapter: universal fallback.
- Generic OpenAI-Compatible adapter: inference-compatible APIs with independently configurable usage/balance semantics.
- Declarative/simple adapters where sufficient.
- Executable adapters for complex providers.

The first dedicated integrations should cover:

- Command Code
- Qoder
- Claude subscription
- Google AI Pro
- OpenAI
- DeepSeek

Future providers such as Devin, Vikey, Kimi, OpenCode, or services that do not yet exist should fit the same core.

## Local/public architecture

Treat public release as a likely next step, not as today's release action.

Committed code should be generic.

Personal state should remain local:
- credentials in Keychain or provider secure storage;
- local database under Application Support;
- real account/subscription configuration outside public fixtures;
- no real usage history committed.

After operational validation we will perform a separate release audit before publishing.

## macOS experience

Deliver a native macOS surface with:
- a useful menu-bar summary;
- provider/product pressure;
- reset information;
- warnings/critical states;
- manual refresh;
- a full detailed window.

Full-window sections:

```text
Overview
Providers
Models
Quotas
History
Costs
Subscriptions
Alerts
Settings
```

The native client talks to the local CMM Usage API with a scoped read-only usage credential. It should not couple itself to SQLite.

## Completion standard

Do not stop at “it compiles.”

Completion means there is evidence that:
- the canonical quota graph cases work;
- dynamic provider lifecycle works;
- source/confidence/freshness is preserved end-to-end;
- forecasting behaves conservatively;
- adapters fail safely;
- metadata refresh cannot trigger inference;
- router telemetry is non-blocking;
- existing CMM Routers tests remain green;
- the macOS client builds/tests;
- the repo is clean of personal/secret artifacts;
- verification documentation records the successful commands/results.

At the end, provide a concise implementation report containing:
- branch and final HEAD;
- commits;
- files/modules added;
- provider integrations actually operational;
- test/build commands and results;
- any provider capabilities that remain unknown because the upstream service does not expose them;
- any real-world validation still required before public release.

Build the system we designed, not a dashboard mockup.
