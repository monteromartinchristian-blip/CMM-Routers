# CMM Usage — Provider/Subscription-Centric Plan Amendment

**Date:** 2026-09-13  
**Applies to:** `docs/superpowers/plans/2026-09-12-cmm-usage-implementation-plan.md`  
**Design authority:** `docs/superpowers/specs/2026-09-13-cmm-usage-provider-centric-amendment.md`

## 1. Accepted baseline

```text
branch: feature/cmm-usage
Task 12A: Command Code complete
commit: 04e93b6c69a104176590a4136d5b21ccbba873f5
```

Task 12A remains accepted.

## 2. Superseded sequence

The previous sequence:

```text
Command Code
Qoder
Claude
Google AI Pro
OpenAI
DeepSeek
```

is superseded. Qoder is no longer on the canonical critical path.

## 3. Revised Task 12 sequence

### Task 12A — Command Code

**Status:** COMPLETE / ACCEPTED.

No changes required.

### Task 12B — Claude / Anthropic subscription

Goal: model Claude subscription usage as canonical provider/product/subscription state, independent from the harness used to consume it.

Required proof:

- current safe non-inference usage source verified;
- rolling/window quota represented independently;
- weekly quota represented independently;
- percentage-only data preserved without invented absolute limits;
- reset times preserved independently;
- source/confidence/freshness retained;
- no harness-specific quota ownership introduced;
- collection does not invoke inference.

Commit target:

```text
feat(usage): add Claude subscription integration
```

### Task 12C — OpenAI API + ChatGPT subscription

Treat these as distinct products/sources even when model families overlap.

Required proof:

- OpenAI API usage/cost source verified;
- ChatGPT subscription usage source used only where safely/currently available;
- API billing and consumer subscription state never conflated;
- rolling/weekly/product limits represented independently where exposed;
- same ModelIdentity may have separate AccessRoutes through API and subscription;
- no inference solely to discover usage.

Commit may be split naturally between API and ChatGPT.

### Task 12D — Google AI Pro / Gemini

Required proof:

- current usage/quota source verified;
- first-party Google pool represented;
- external OpenAI/Anthropic pool represented where applicable;
- shared/subgroup windows represented through ordinary QuotaBuckets/Bindings;
- independent resets preserved;
- no Google-specific branch added to the core resolver.

Commit target:

```text
feat(usage): add Google AI Pro integration
```

### Task 12E — DeepSeek API

Required proof:

- official balance source verified;
- balance has no invented reset;
- router-measured tokens remain separate observations;
- provenance distinguishes provider balance from local telemetry;
- no inference for quota discovery.

Commit target:

```text
feat(usage): add DeepSeek integration
```

### Task 12F — Qwen Token Plan + Qwen PAYG

Treat Token Plan and PAYG as distinct products/configurations with independent secrets/configuration when required.

Required proof:

- current supported usage/balance/quota source verified for each;
- no shared-secret assumption unless provider contract truly shares credentials;
- quotas/balances remain product-specific;
- routes may share ModelIdentity while retaining product-specific quota graphs.

Commits may be split by product.

### Task 12G — Additional quota-owning providers

Only after 12B-12F prove the architecture.

Candidates:

```text
Vikey
TokenRouter
Cavoti
other genuine quota-owning products
```

Prioritize by user value and availability of safe non-inference metadata.

## 4. Later harness telemetry phase

Possible optional integrations:

```text
Qoder
Hermes
Codex
Claude Code
other harnesses/IDEs
```

Purpose:

- attribute UsageEvent origin;
- supplement telemetry when provider sources are incomplete;
- provide local diagnostics.

They do not own canonical quota state unless they expose a genuine independent quota product.

## 5. Existing Qoder work

If uncommitted Qoder code exists when execution resumes:

1. Inspect it.
2. Do not delete it automatically.
3. Do not commit it as a canonical provider integration.
4. Preserve useful work in an isolated patch/stash or adapt it later as harness telemetry.
5. Do not let it block Task 12B Claude.
6. Do not add Qoder-specific branches to the canonical quota engine.
7. Report what was done with the existing Qoder diff.

## 6. UsageEvent origin metadata

Add safe origin metadata only if it fits naturally without destabilizing completed work.

Illustrative semantics:

```ts
type UsageOrigin =
  | { kind: "router"; id?: string }
  | { kind: "harness"; id: string }
  | { kind: "provider"; id: string }
  | { kind: "manual"; id?: string }
  | { kind: "unknown" };
```

Requirements:

- no secrets;
- origin never changes quota ownership;
- optional for historical events;
- absence does not block ingestion;
- do not fabricate origin for old rows.

This must not derail provider integration work.

## 7. Verification additions

Before final acceptance, prove:

1. one subscription consumed from two harness origins still maps to one quota graph;
2. changing harness does not alter AccessRoute identity;
3. harness origin is queryable for usage attribution if captured;
4. provider/subscription quota state works with no harness telemetry;
5. Command Code remains canonical because GOAT owns its quota system;
6. optional harness telemetry can be disabled without affecting provider quota state.

## 8. macOS UI implication

Primary navigation remains provider/product/model/quota-centric.

Harness attribution belongs in secondary analysis such as:

```text
Usage by origin
Hermes
Qoder
Codex
CMMChat
```

Do not make harnesses top-level quota owners unless the harness also represents a real quota-owning product.

## 9. Execution instruction

Continue from the accepted Command Code checkpoint.

Do not reopen Tasks 1-11 or Task 12A.

Do not spend the next implementation cycle polishing Qoder.

Proceed with Claude / Anthropic subscription as the next canonical integration.

The frozen 2026-09-12 spec remains authoritative except where the 2026-09-13 provider-centric design amendment explicitly clarifies ownership or task priority.
