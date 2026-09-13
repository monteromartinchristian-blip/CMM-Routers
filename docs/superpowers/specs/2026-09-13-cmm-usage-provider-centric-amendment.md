# CMM Usage — Provider/Subscription-Centric Architecture Amendment

**Date:** 2026-09-13  
**Status:** APPROVED DESIGN AMENDMENT  
**Applies to:** `docs/superpowers/specs/2026-09-12-cmm-usage-design.md`  
**Repository:** `CMM-Routers`

## 1. Purpose

CMM Usage is **provider/subscription-centric, not harness-centric**.

Harnesses such as Qoder, Hermes, Codex, Claude Code, CMMChat, or other clients may be useful telemetry sources, but they do not define the canonical quota domain merely because inference is launched through them.

The canonical source of truth remains:

`Provider -> Account -> Product/Subscription -> AccessRoute -> ModelIdentity + QuotaBuckets`

This amendment sharpens the meaning of `AccessRoute`, the role of adapters/sources, and provider-integration priority without invalidating the frozen 2026-09-12 design.

## 2. Canonical ownership rule

An entity belongs in the canonical CMM Usage quota domain when it **owns or imposes a real quota, balance, billing pool, subscription allowance, or access product**.

Canonical examples:

- Anthropic / Claude Pro
- OpenAI API
- ChatGPT subscription where usage can be observed safely
- Google AI Pro
- DeepSeek API
- Command Code GOAT
- Qwen Token Plan
- Qwen PAYG as a separate product/configuration when its semantics differ

A component is not canonical merely because it is the client used to send requests.

Harness examples:

- Qoder
- Hermes
- Codex
- CMMChat
- other IDE/agent shells

## 3. Harnesses are observation origins or auxiliary sources

Harnesses may contribute:

- `HarnessTelemetrySource`
- local metadata
- `UsageEvent` origin
- diagnostic context

They do not create a parallel quota hierarchy unless the harness itself owns a genuine independent product/quota.

Example:

```text
Anthropic
└── Claude Pro
    └── Claude Sonnet access route
        ├── 5h quota
        └── weekly quota

Usage may originate from:
- Hermes
- Qoder
- Codex
- CMMChat
```

All origins consume the same canonical Claude Pro quota graph.

Removing or replacing one harness must not delete or redefine the subscription, access route, or quota buckets.

## 4. AccessRoute clarification

`AccessRoute` means one concrete provider/product/subscription path through which a model can be consumed.

It does **not** mean one harness/client.

Valid conceptual route:

```text
Provider: Anthropic
Account: personal
Product: Claude Pro
ModelIdentity: Claude Sonnet
AccessRoute: Claude Pro -> Claude Sonnet
```

Harness/client attribution belongs on the usage observation/event, e.g.:

```text
origin:
  kind: harness
  id: hermes
```

This enables later analysis by origin without changing quota ownership.

## 5. Usage source model

The existing `UsageAdapter` interface may remain for compatibility.

Conceptually, adapters are usage observation sources:

```text
ProviderUsageSource
SubscriptionUsageSource
RouterTelemetrySource
HarnessTelemetrySource
ManualUsageSource
```

A future internal rename to `UsageSource` is optional. Behavioral separation matters more than renaming.

## 6. Source authority

When observations overlap, reconciliation remains provenance- and freshness-aware.

Typical authority order:

```text
provider official API/SDK
provider official product/subscription metadata
provider official CLI/local metadata
router-measured telemetry
harness auxiliary telemetry
manual
derived/estimated
```

Freshness and exactness can still override simplistic source ordering.

## 7. Command Code remains canonical

Task 12A remains valid.

Command Code GOAT owns a real quota system: plan credits/windows and model/org-specific constraints. Its relevance is therefore quota ownership, not harness status.

No rollback or redesign of Task 12A is required.

## 8. Qoder changes role

Qoder is removed from the canonical provider/subscription critical path.

If Qoder exposes useful non-inference metadata, it may remain valuable later as an optional harness/local telemetry integration.

Rules:

- Qoder is not required to prove the CMM Usage core.
- Qoder must not define canonical quota ownership unless a distinct Qoder-owned quota product is explicitly modeled.
- Existing uncommitted Qoder work may be parked, isolated, or later adapted to harness telemetry.
- Do not spend more effort polishing Qoder before canonical provider/subscription integrations are complete.

## 9. Revised canonical implementation priority

After Command Code:

1. Claude / Anthropic subscription
2. OpenAI API and ChatGPT subscription as distinct products/sources
3. Google AI Pro / Gemini subscription
4. DeepSeek API
5. Qwen Token Plan and Qwen PAYG as distinct configurations/products
6. Other quota-owning providers/products such as Vikey, TokenRouter, Cavoti, etc.

Harness integrations such as Qoder, Hermes, Codex, Claude Code, and similar clients move to a later optional telemetry phase.

## 10. Public product positioning

CMM Usage should be understandable without reference to a harness.

Preferred framing:

> A universal local AI subscription/API usage and quota monitor.

Providers and subscriptions are connected or modeled once. Any number of clients/harnesses may consume them. CMM Usage preserves quota state independently from the client used to generate traffic.

## 11. Acceptance implications

The architecture is correct only if:

1. Replacing Qoder with Hermes does not alter canonical provider/subscription records.
2. Using multiple harnesses simultaneously does not duplicate quota buckets.
3. A `UsageEvent` can retain safe origin metadata for harness attribution.
4. A harness can disappear without deleting provider/subscription history.
5. A harness that owns a real independent quota product can still be modeled canonically for that product.
6. Command Code GOAT remains valid as a quota-owning product.
7. Core quota resolution remains independent from harness-specific branching.
8. Provider/subscription integrations remain the primary proof of correctness.

## 12. Relationship to the frozen spec

All prior frozen decisions remain valid except where this amendment clarifies terminology or execution priority.

Unchanged:

- quota graph architecture
- ModelIdentity vs AccessRoute
- arbitrary windows and metrics
- event + snapshot ingestion
- provenance/confidence
- dynamic provider lifecycle
- SQLite local persistence
- secure credential handling
- no automatic routing in v1
- public-ready-by-construction

This amendment is authoritative where the prior implementation plan treated Qoder as a canonical dedicated provider integration.
