# Qwen Token Plan / Qwen PAYG usage source notes

Verified on 2026-09-13 against the official Alibaba Cloud Model Studio
documentation (alibabacloud.com/help/en/model-studio: token-plan-overview,
coding-plan, model-pricing, kilo-cli-coding-plan, opencode) and the installed
`qwen-code@0.20.0` bundle (provider preset
`packages/core/src/providers/presets/alibaba-token-plan.ts`).

## Confirmed provider semantics

Two distinct products under one provider, per official docs:

- **Token Plan** (Personal/Team editions): subscription, unified **Credits**
  deduction. Personal: fixed 7-day window (timer starts at first invocation;
  full reset when the window elapses; no carry-over). Team: per-seat monthly
  quota, subscription-month cycle. Dedicated API keys (`sk-sp-*`) and dedicated
  base URLs (`https://token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1`
  or `.../apps/anthropic`). Compatible with OpenAI protocol; model support is
  an exact allowlist surfaced by the plan.
- **Qwen PAYG** (Model Studio API): post-paid `sk-`/`sk-ws-` keys against
  `https://dashscope.<region>.aliyuncs.com/compatible-mode/v1`. Billed per
  model token price (documented tiered pricing), not Credits.

The docs are explicit that these must not be mixed: using the wrong key type
against the wrong base URL silently reroutes consumption to normal API billing.
There is therefore **no shared credential or quota namespace** between the two
products, and no PAYG fallback path is configured.

## Non-inference sources available today

- **Model inventory:** `GET /models` on each product's own base URL (the
  official OpenAI-compatible metadata surface the CLI uses). Pure listing, no
  inference. The adapter treats discovery as authoritative and stores the exact
  ids — no hardcoded catalog.
- **Plan quota consumption:** the official docs expose Token Plan/Coding Plan
  usage only through the authenticated Model Studio **console pages**
  ("Check your usage on the Coding Plan page"); no supported machine-readable
  quota/usage API is documented as of 2026-09-13, and none exists in the
  installed CLI's own code paths. Inference responses must not be polled for
  quota state and headers are not a documented contract.

Consequently the adapter:

1. discovers models via `GET /models` only (one endpoint, proven by test);
2. represents the Token Plan window from **operator plan evidence**
   (`windowLimitCredits` = the purchased tier's published quota — provider
   truth, not invented) with status `unknown` and **no snapshot** until an
   observation exists;
3. accepts operator-recorded console observations (used/remaining Credits,
   window reset time) through an injected `observations()` callback and emits
   them as `QuotaSnapshot`s with `source: manual`, `confidence: measured`,
   24h staleness, native Credits units, and independent resets. Values outside
   `[0, limit]` and malformed timestamps are conservatively dropped from
   fractions; the adapter never converts percentages or partial data into
   invented absolute consumption;
4. exposes **no** quota capability for PAYG (billing data would come from the
   Alibaba Cloud BSS account APIs — an account-level billing surface outside
   this provider's model-usage contract, deliberately not claimed).

## Isolation guarantees (proven by tests)

- Distinct adapter ids (`qwen-token-plan`, `qwen-payg`), accounts
  (`account:qwen-token-plan` vs `account:qwen-payg`), and products
  (`product:qwen-token-plan` kind `subscription` vs `product:qwen-payg` kind
  `api`) with their own credential references.
- Identical discovered models produce **shared** `ModelIdentity` ids
  (`model:qwen:<id>`) but per-product `AccessRoute` ids
  (`route:qwen-token-plan:<id>` / `route:qwen-payg:<id>`), so the same model
  routes through each product's independent quota graph.
- Quota keys stay inside the adapter (`credits-window:7day` /
  `credits-window:month`); the core resolver has no Qwen branch.
