# CMM Usage — Design Specification

**Date:** 2026-09-12
**Status:** FROZEN DESIGN — user-approved functional architecture
**Repository:** `CMM-Routers`
**Canonical local repository:** `$HOME/CMM-Routers`
**Scope:** local-first usage, quota, cost, reset, forecasting, and alerting subsystem for APIs, subscriptions, provider plans, and individual models used directly or through CMM Routers.

---

## 1. Goal

Build **CMM Usage** as the canonical local observability subsystem for AI consumption across APIs, subscriptions, provider plans, model-specific limits, shared model pools, rolling windows, weekly/monthly limits, credits, balances, and provider-defined quota systems.

CMM Usage must answer, without requiring the user to open each provider website:

1. What have I used?
2. What remains?
3. Which quota is currently constraining a provider, access route, or model?
4. When does each quota reset?
5. At the current burn rate, will I exhaust a quota before reset?
6. Which subscription/API/provider/model is responsible for consumption?
7. What is the source and confidence of each displayed value?
8. Which subscriptions or APIs can be added, paused, cancelled, restored, or replaced without redesigning the core?

CMM Usage is part of **CMM Routers**, but its domain model is independent from inference routing so it can later serve CMMChat, CMM OS, CMM Bots, native macOS UI, and other local clients without duplicating quota logic.

---

## 2. Product principles

### 2.1 Quotas are a graph, not a tree

The core must never assume a fixed hierarchy such as:

`provider -> plan -> model -> limit`

Real providers can impose:

- one global quota shared by many models;
- one quota for all free models;
- model-specific quotas;
- one pool shared by OpenAI/Anthropic models and another by first-party models;
- simultaneous 5-hour, weekly, monthly, or billing-cycle limits;
- weighted or provider-defined units;
- balances that have no temporal reset;
- multiple accounts or subscriptions exposing the same model;
- the same model through multiple providers with independent quotas.

The canonical abstraction is therefore a **many-to-many graph of AccessRoutes and QuotaBuckets connected by QuotaBindings**.

### 2.2 A model is not an access route

`ModelIdentity` describes the conceptual model.

`AccessRoute` describes one concrete way the user can access that model through a specific provider/account/product/subscription.

Example:

`Claude X` may have separate AccessRoutes through Anthropic, Google AI Pro, Command Code, and an aggregator. Those routes may share the same ModelIdentity while having entirely independent quota graphs.

### 2.3 No invented precision

CMM Usage must preserve the distinction between:

- values reported exactly by a provider;
- values measured by CMM Routers;
- values calculated from exact inputs;
- values estimated or inferred;
- values manually configured;
- unknown values.

Estimated and exact values must never be silently merged or presented with identical confidence.

### 2.4 Local-first and content-blind

CMM Usage stores usage metadata, not conversation content.

By default it must never persist:

- prompts;
- completions;
- source file contents;
- tool arguments/results;
- OAuth tokens;
- API keys;
- Authorization headers.

### 2.5 Extensible by default

Adding or removing a provider, API, plan, subscription, account, or model must not require redesigning the core.

A provider unknown at the time of v1 release must still be representable through:

- a declarative adapter;
- the Generic OpenAI-Compatible adapter; or
- the Manual Subscription/API adapter.

### 2.6 Observation before control

CMM Usage v1 may:

- observe;
- measure;
- normalize;
- reconcile;
- persist;
- forecast;
- alert;
- expose read-only health/pressure information.

CMM Usage v1 must **not automatically reroute inference**.

The core must expose stable read APIs that a later quota-aware router policy can consume without redesigning CMM Usage.

---

## 3. Non-goals for v1

- No automatic provider/model switching.
- No automatic purchase, top-up, subscription change, or cancellation.
- No hidden PAYG fallback.
- No inference request solely to discover usage or quota state.
- No mandatory website scraping in the core.
- No cloud synchronization of secrets.
- No prompt/completion logging.
- No attempt to convert every provider metric into tokens.
- No fabricated common “availability percentage” across incomparable metrics.
- No destructive deletion of historical usage when a subscription is cancelled or an account is disabled.
- No requirement that every provider expose all possible metrics.

---

## 4. Integration boundary inside CMM Routers

CMM Usage lives under a dedicated namespace and must not leak provider-specific quota semantics into existing inference adapters.

Recommended shape:

```text
src/
  usage/
    domain/
    registry/
    adapters/
    collectors/
    reconciliation/
    forecasting/
    alerts/
    storage/
    service/
    api/
  providers/          # existing inference adapters remain separate
  observability/      # existing general router observability remains separate

tests/
  usage/
    domain/
    adapters/
    reconciliation/
    forecasting/
    alerts/
    storage/
    api/
    fixtures/

apps/
  cmm-usage-macos/    # native SwiftUI menu-bar/full-window client
```

Existing provider adapters may emit normalized usage events to CMM Usage, but CMM Usage adapters are separate because quota discovery and inference transport have different permissions, failure modes, and lifecycle.

---

## 5. Canonical domain model

All durable IDs must be stable opaque strings. Display names may change without changing identity.

### 5.1 Provider

Represents a vendor/service organization.

Required fields:

```text
id
displayName
kind
status
metadata
createdAt
updatedAt
```

`kind` supports at least:

- `first_party`
- `aggregator`
- `client_plan`
- `manual`
- `generic`

Provider identity must not imply account or subscription identity.

### 5.2 Account

Represents one logical account under a provider.

Required fields:

```text
id
providerId
label
status
externalAccountHint?
createdAt
updatedAt
```

`externalAccountHint`, if used, must be non-secret and safe to display.

Multiple accounts for the same provider are supported.

### 5.3 Product

Represents a provider product or commercial access mechanism.

Examples:

- Claude Pro
- Google AI Pro
- Command Code GOAT
- OpenAI API
- DeepSeek API

Required fields:

```text
id
providerId
displayName
kind
metadata
```

### 5.4 SubscriptionPeriod

Represents one bounded period during which an account has access to a product.

Required fields:

```text
id
accountId
productId
status
startedAt
endedAt?
billingAmount?
billingCurrency?
metadata
```

Status:

- `active`
- `paused`
- `cancelled`
- `expired`
- `archived`

Cancelling a subscription closes the period; it never deletes history.

Re-subscribing later creates a new SubscriptionPeriod.

### 5.5 ModelIdentity

Represents a conceptual model independent of route.

Required fields:

```text
id
canonicalName
vendor
family?
version?
lifecycle
aliases[]
metadata
```

Lifecycle:

- `active`
- `deprecated`
- `removed`
- `unknown`

A provider-specific identifier is not itself the canonical identity.

### 5.6 AccessRoute

Represents one concrete way to use a model.

Required fields:

```text
id
accountId
productId
subscriptionPeriodId?
modelIdentityId?
providerModelId
displayName
status
metadata
```

Status:

- `available`
- `degraded`
- `unavailable`
- `disabled`
- `unknown`

The same ModelIdentity may have any number of AccessRoutes.

An AccessRoute may temporarily have no canonical ModelIdentity when discovery cannot yet resolve an alias. That must not block quota tracking for the route.

### 5.7 QuotaGroup

Presentation/semantic grouping only.

Examples:

- Google models
- External models
- General plan limits
- Model-specific limits
- Free model pool

Required fields:

```text
id
productId
displayName
description?
sortOrder
```

QuotaGroup must never be treated as a limit unless an explicit QuotaBucket exists.

### 5.8 QuotaBucket

Represents one independently exhaustible quota or balance.

Required fields:

```text
id
accountId
productId
quotaGroupId?
displayName
metric
windowPolicy
limitValue?
unit
enforcement
status
providerKey?
metadata
```

`limitValue` may be unknown.

`status` supports:

- `healthy`
- `warning`
- `critical`
- `exhausted`
- `unavailable`
- `unknown`

`enforcement` supports:

- `hard`
- `soft`
- `unknown`

One QuotaBucket may constrain many AccessRoutes.

### 5.9 QuotaBinding

Many-to-many link between AccessRoute and QuotaBucket.

Required fields:

```text
id
accessRouteId
quotaBucketId
consumptionRuleId?
activeFrom
activeTo?
priority?
metadata
```

An AccessRoute may be constrained by zero, one, or many QuotaBuckets.

A QuotaBucket may constrain zero, one, or many AccessRoutes.

### 5.10 ConsumptionRule

Describes how usage for an AccessRoute maps to a QuotaBucket.

Required fields:

```text
id
measurement
weight?
observable
providerDefinedKey?
metadata
```

Measurement supports:

- `reported`
- `tokens`
- `input_tokens`
- `output_tokens`
- `requests`
- `credits`
- `currency`
- `compute_units`
- `weighted_units`
- `provider_defined`

If the provider's conversion is unknown, CMM Usage must not invent one.

### 5.11 UsageEvent

Represents a discrete observed consumption event.

Required fields:

```text
id
occurredAt
providerId
accountId
productId
accessRouteId?
modelIdentityId?
requestCorrelationId?
inputTokens?
outputTokens?
cachedInputTokens?
cachedOutputTokens?
requests?
providerUnits?
providerUnitName?
costAmount?
costCurrency?
source
confidence
metadata
```

`requestCorrelationId` must be non-secret and must not encode prompt content.

UsageEvent does not require every metric.

### 5.12 CostEvent

Represents a durable cost/balance movement independent from token usage.

Required fields:

```text
id
occurredAt
providerId
accountId
productId
accessRouteId?
amount
currency
kind
source
confidence
metadata
```

`kind` supports:

- `usage`
- `credit`
- `top_up`
- `subscription_fee`
- `adjustment`
- `unknown`

### 5.13 QuotaSnapshot

Represents the provider- or system-reported state of one QuotaBucket at a point in time.

Required fields:

```text
id
quotaBucketId
observedAt
usedValue?
remainingValue?
limitValue?
usedFraction?
remainingFraction?
resetAt?
providerResetText?
source
confidence
stalenessAfter
rawSafeMetadata?
```

A snapshot can exist even when only a percentage is known.

CMM Usage must not back-calculate an exact absolute limit from a percentage unless the absolute limit is independently known.

### 5.14 AdapterCapability

Each adapter publishes capabilities independently:

```text
discover_accounts
discover_products
discover_models
discover_quota_graph
collect_usage_events
collect_quota_snapshots
collect_costs
collect_balances
collect_resets
manual_refresh
background_refresh
```

Unsupported capabilities are explicit and normal.

### 5.15 AlertRule and AlertEvent

AlertRule:

```text
id
scope
scopeId
kind
threshold?
enabled
cooldown
metadata
```

Kinds include:

- `usage_fraction`
- `remaining_fraction`
- `predicted_exhaustion`
- `burn_rate`
- `quota_exhausted`
- `adapter_stale`
- `adapter_failed`
- `subscription_low_utilization`

AlertEvent stores the actual triggered condition and resolved/acknowledged state.

---

## 6. Metric model

Metric semantics are open and extensible.

Built-in metrics:

```text
tokens
input_tokens
output_tokens
requests
credits
currency
compute_units
weighted_units
percentage
provider_defined
```

Each value always carries a unit.

CMM Usage must not compare or aggregate incompatible units.

A provider-defined metric carries both a stable provider key and a display unit.

---

## 7. Window model

The core must not hard-code 5-hour, weekly, or monthly assumptions.

`WindowPolicy` supports:

### 7.1 Rolling duration

Example: last 5 hours.

```text
kind = rolling_duration
durationSeconds
```

### 7.2 Fixed calendar

Examples: calendar day, ISO week, provider-local week.

```text
kind = fixed_calendar
calendarUnit
timezone
anchor
```

### 7.3 Billing cycle

```text
kind = billing_cycle
anchorDate
timezone
```

### 7.4 Provider reported

Used when the provider supplies a reset timestamp or textual reset but its formal window semantics are unavailable.

```text
kind = provider_reported
```

### 7.5 None

For balances/credits with no reset window.

```text
kind = none
```

Reset time is data, not identity. Repeated windows reuse the same bucket identity while snapshots record changing reset times.

---

## 8. Source and confidence semantics

Every observed or derived usage/quota/cost value records both `source` and `confidence`.

### 8.1 Source

Canonical source categories, ordered by preferred authority when equally fresh:

1. `provider_official_api`
2. `provider_official_sdk`
3. `provider_official_cli`
4. `provider_local_state`
5. `router_measured`
6. `manual`
7. `derived`
8. `estimated`

This ordering is not allowed to override freshness blindly.

### 8.2 Confidence

- `exact`
- `measured`
- `calculated`
- `estimated`
- `unknown`

### 8.3 Reconciliation rule

For the same semantic observation:

1. Reject invalid or impossible values.
2. Prefer non-stale over stale data.
3. Prefer provider-authoritative exact data over locally inferred data when timestamps are comparable.
4. Preserve conflicting snapshots rather than silently deleting them.
5. Expose the selected current value plus provenance.
6. Keep historical values for diagnostics.
7. Never “upgrade” an estimated value to exact by formatting.

---

## 9. Two ingestion modes

### 9.1 Event mode

Used when individual requests can be observed.

```text
request -> normalized UsageEvent/CostEvent -> store
```

Existing CMM Routers inference paths should emit usage metadata after provider normalization when available.

Event ingestion must be non-blocking with respect to inference: a storage/telemetry failure must not corrupt a successful inference response.

### 9.2 Snapshot mode

Used when a provider only exposes aggregate state.

```text
adapter poll/manual refresh -> QuotaSnapshot -> reconciliation -> store
```

A provider may use both modes simultaneously.

---

## 10. Quota resolution

There is deliberately no universal single percentage for a model.

For an AccessRoute:

1. Resolve all active QuotaBindings.
2. Load the current reconciled state of each QuotaBucket.
3. Evaluate each bucket independently in its native metric.
4. Determine route state from all applicable buckets.
5. Report the **constraining bucket(s)**.
6. Never average unrelated percentages.

### 10.1 Route state

- `exhausted`: at least one hard bucket is exhausted.
- `critical`: not exhausted, but at least one bucket is critical or predicted to exhaust before reset.
- `warning`: no critical bucket, but at least one warning condition exists.
- `healthy`: all known applicable buckets are healthy.
- `unknown`: insufficient current data and no stronger known state.
- `unavailable`: access route/provider is unavailable independently of quota.

### 10.2 Multiple constraints

If multiple buckets constrain a route, return all of them with one marked primary according to:

1. exhausted hard constraint;
2. earliest predicted exhaustion before reset;
3. lowest remaining fraction within comparable semantics;
4. explicit provider priority;
5. stable deterministic tie-break.

---

## 11. Forecasting and burn rate

Forecasting is advisory and must always carry calculated/estimated confidence.

For quota buckets with enough history:

- calculate recent burn rate;
- calculate sustainable rate until reset;
- project exhaustion time;
- calculate pace ratio.

Example:

```text
paceRatio = currentBurnRate / sustainableBurnRate
```

A pace ratio above 1 means the current rate would exhaust the bucket before reset.

Forecasting must:

- require a minimum sample/history threshold;
- ignore clearly stale samples;
- account for resets;
- never cross-aggregate incompatible metrics;
- return `unknown` when data is insufficient.

---

## 12. Alerting

Default alert thresholds may be configurable, but the core must support:

- warning by used fraction;
- critical by used fraction;
- predicted exhaustion before reset;
- actual exhaustion;
- abnormally high burn rate;
- stale adapter state;
- repeated adapter failure;
- low subscription utilization.

Recommended default UI behavior:

- warning at >= 75% used when an exact/calculated fraction exists;
- critical at >= 90% used;
- critical when predicted exhaustion occurs before reset;
- exhausted at provider-reported or mathematically exact exhaustion.

Provider-specific rules may override defaults where percent is not meaningful.

Alerts must have deduplication/cooldown to prevent notification storms.

---

## 13. Adapter architecture

### 13.1 Adapter contract

A CMM Usage adapter exposes:

```text
id
manifest()
capabilities()
health()
discover()
collectUsageEvents(cursor?)
collectQuotaSnapshots()
collectCostEvents(cursor?)
refresh()
```

Each method must:

- be independently optional according to capabilities;
- return normalized domain objects;
- never expose credentials;
- distinguish auth failure, unsupported capability, provider unavailable, rate limit, stale data, and parse/protocol failure.

### 13.2 Collection safety invariant

A usage adapter must **never perform paid or quota-consuming inference merely to discover usage**.

Metadata endpoints, official account APIs, official SDKs, local provider state, or non-inference CLI commands are allowed.

If the only way to discover quota would be to trigger inference, the adapter must return unsupported/unknown instead.

### 13.3 Declarative adapters

For simple providers, a manifest/config may define:

- provider/account/product;
- model list or discovery endpoint;
- quota buckets;
- bindings;
- units;
- reset rules;
- safe metadata endpoints.

No new core code should be required.

### 13.4 Executable adapters

Complex providers may implement custom TypeScript logic behind the same contract.

### 13.5 Generic OpenAI-Compatible adapter

Must allow configuration of:

- base URL;
- Keychain reference for API key;
- optional models endpoint;
- optional usage/balance endpoint mapping;
- manually declared quota buckets when provider APIs omit them.

It must never assume that OpenAI-compatible inference implies OpenAI-compatible billing/usage APIs.

### 13.6 Manual Subscription/API adapter

Must allow the user to create:

- provider;
- account;
- product/subscription;
- model/access routes;
- arbitrary quota buckets;
- quota bindings;
- reset rules;
- manual snapshots.

This is the universal fallback for a new provider before a dedicated adapter exists.

---

## 14. Provider lifecycle and dynamic registry

CMM Usage must not compile the user's current subscriptions into the core.

The registry supports:

- enable;
- disable;
- pause;
- cancel;
- archive;
- re-enable;
- multiple accounts;
- multiple products per provider;
- multiple subscription periods;
- multiple access routes to the same model.

Removing an active integration from the dashboard must never delete historical records.

Adapter registration and product/account activation are separate concerns.

---

## 15. Initial integration targets

The initial implementation must prove the architecture with these targets:

1. **Command Code**
   - shared plan limits;
   - multiple simultaneous windows;
   - model-specific constraints where exposed;
   - provider-defined/weighted units where necessary.

2. **Qoder**
   - account/token-plan quota where exposed through supported local/official interfaces;
   - read-only usage collection.

3. **Claude subscription**
   - provider-reported rolling/session/window limits and weekly limits where supported;
   - preserve unknown absolute values when only percentages are exposed.

4. **Google AI Pro**
   - separate quota pools/groups where the service separates first-party Google models from external OpenAI/Anthropic models;
   - nested/shared windows represented through bucket bindings rather than hard-coded hierarchy.

5. **OpenAI**
   - API usage/cost where official account/project APIs are available;
   - subscription usage only through supported non-inference mechanisms if available.

6. **DeepSeek API**
   - balance/credit state;
   - locally measured request/token history when routed through CMM Routers.

7. **Generic OpenAI-Compatible API**

8. **Manual Subscription/API**

The adapter layer must be ready for future integrations such as Devin, Vikey, Kimi, OpenCode, or unknown future providers without core redesign.

Implementation must verify each provider's current supported usage mechanism at execution time. The domain contract above is frozen; provider endpoint details are not guessed.

---

## 16. Storage

### 16.1 Canonical store

Use SQLite through an internal `UsageStore` abstraction.

Canonical macOS data directory:

```text
$HOME/Library/Application Support/CMM Routers/Usage/
```

Canonical database:

```text
cmm-usage.sqlite
```

The database is **machine-local** and must not be placed in iCloud Drive.

### 16.2 SQLite implementation

The existing repo baseline is Node.js 26+. The first implementation may use the built-in `node:sqlite` module behind the `UsageStore` interface, with defensive mode, prepared statements, transactions, foreign keys, and WAL where supported by the runtime.

No caller outside `src/usage/storage/` may depend directly on `node:sqlite`, so the persistence implementation remains replaceable.

### 16.3 Migrations

- schema version table;
- ordered immutable migration files;
- migration transaction where supported;
- startup fails safely on unknown newer schema;
- migration tests from empty DB and previous fixture versions;
- no destructive migration without explicit documented data migration.

### 16.4 Retention

UsageEvent, CostEvent, SubscriptionPeriod, and QuotaSnapshot history is retained by default.

Future compaction may aggregate old high-frequency UsageEvents, but v1 must not silently discard data.

---

## 17. Secrets and credentials

Secrets live in macOS Keychain or existing provider-supported secure storage.

CMM Usage stores only secure references such as service/account identifiers.

Never store:

- raw provider API keys;
- OAuth tokens;
- refresh tokens;
- router bearer tokens;
- cookies/session secrets.

The existing CMM Routers fail-closed secret/redaction policy applies.

---

## 18. Collection scheduler

The usage service contains a scheduler that:

- runs only enabled adapters;
- respects adapter-declared minimum refresh intervals;
- applies backoff after failure;
- applies small jitter to avoid synchronized polling;
- never retries in a tight loop;
- records adapter health;
- distinguishes stale data from failed collection;
- supports user-triggered manual refresh;
- shuts down cleanly with the router.

A provider rate limit on usage metadata must not affect inference routing except through explicit diagnostic state.

---

## 19. Read API

Preserve the existing diagnostic concept `GET /v1/cmm/usage`, evolving it into a stable summary endpoint.

Add read-only CMM Usage endpoints under a versioned local API namespace, for example:

```text
GET /v1/cmm/usage
GET /v1/cmm/usage/providers
GET /v1/cmm/usage/products
GET /v1/cmm/usage/models
GET /v1/cmm/usage/routes
GET /v1/cmm/usage/quotas
GET /v1/cmm/usage/history
GET /v1/cmm/usage/costs
GET /v1/cmm/usage/alerts
POST /v1/cmm/usage/refresh
```

Mutation endpoints for manual provider/subscription configuration must be separately authenticated and explicitly scoped.

The macOS UI must not call inference endpoints.

---

## 20. Future router integration contract

CMM Usage v1 exposes stable internal read methods:

```text
getRouteHealth(accessRouteId)
getModelConstraints(modelIdentityId)
getProviderPressure(providerId)
getQuotaState(quotaBucketId)
```

Return values include:

- status;
- constraining buckets;
- provenance;
- freshness;
- forecast where available.

The existing inference router must not consume these methods for automatic routing in v1.

---

## 21. macOS client

CMM Usage includes a native macOS client, kept separate from the TypeScript domain engine.

### 21.1 Menu bar

The menu-bar surface shows:

- overall state;
- provider/product state;
- warning/critical badges;
- remaining/reset summaries;
- manual refresh;
- open full window.

A provider is not reduced to one percentage when it has heterogeneous constraints.

### 21.2 Full window

Required sections:

- Overview
- Providers
- Models
- Quotas
- History
- Costs
- Subscriptions
- Alerts
- Settings

### 21.3 Model detail

A model/access route view must show every applicable bucket independently.

Example:

```text
Muse Spark
Model-specific       97% used
Weekly               76% used
Monthly              42% used
5 h                  31% used

Primary constraint:
Model-specific quota
```

### 21.4 Provenance

Every displayed quota supports a detail view exposing:

- source;
- confidence;
- observed time;
- staleness;
- reset;
- exact/measured/estimated status.

### 21.5 UI/backend boundary

The macOS client consumes the local read API. It must not read the SQLite database directly.

Use a dedicated read-only local credential stored in Keychain rather than granting the UI an inference-capable bearer.

---

## 22. Privacy and security invariants

Mandatory:

1. Local service remains bound to loopback.
2. CMM Usage does not expose secrets in API responses.
3. No prompt/completion content is persisted.
4. No collector may invoke inference merely to inspect quota.
5. No automatic PAYG fallback.
6. No automatic cross-provider routing in v1.
7. Unknown quota state is represented as unknown, not healthy.
8. Provider parsing failures fail closed for that data source.
9. Manual entries are visibly marked manual.
10. Estimated values are visibly marked estimated.
11. Database path is local and not synchronized by default.
12. Public-repo fixtures contain no user-specific home paths, tokens, account IDs, or secrets.
13. All logs pass existing CMM Routers redaction policy.
14. The UI credential has read-only usage scope.

---

## 23. Error taxonomy

CMM Usage extends diagnostics with stable categories:

```text
usage_adapter_unavailable
usage_adapter_auth_required
usage_adapter_rate_limited
usage_adapter_protocol_error
usage_adapter_unsupported
usage_data_stale
usage_data_conflict
usage_storage_error
usage_migration_error
usage_invalid_manual_config
usage_quota_unknown
```

Errors carry safe provider/account/product identifiers, never secrets.

Adapter failure must not crash the inference router.

---

## 24. Testing strategy

### 24.1 Domain unit tests

Prove:

- one bucket -> many routes;
- one route -> many buckets;
- same ModelIdentity -> multiple independent AccessRoutes;
- quota groups do not behave as limits;
- incompatible metrics are never averaged;
- unknown values remain unknown;
- source/confidence is preserved;
- cancellation/re-subscription preserves historical periods.

### 24.2 Canonical quota fixtures

The suite must contain deterministic fixtures for:

1. model-specific API quota;
2. shared free-model pool;
3. Command Code-style simultaneous global + 5h + weekly + model-specific limits;
4. Google AI Pro-style split model pools with shared and subgroup constraints;
5. Claude-style rolling/window + weekly constraints;
6. OpenAI-style multiple temporal constraints;
7. balance-only API;
8. provider reporting only percentages;
9. stale provider snapshot plus newer router measurement;
10. conflicting exact and estimated observations.

### 24.3 Reconciliation tests

Prove:

- fresh authoritative data wins over comparable local estimates;
- stale authoritative data does not blindly override fresh measurements;
- conflicts remain inspectable;
- exact is never fabricated from estimated input.

### 24.4 Storage tests

Prove:

- empty migration;
- reopen persistence;
- foreign-key integrity;
- transactions;
- WAL/locking behavior under supported runtime;
- no secret columns;
- history survives provider disable/cancel;
- migration from fixture schema.

### 24.5 Adapter contract tests

Every executable adapter receives the same contract suite.

It must prove:

- no inference endpoint is called during quota collection;
- auth failure is normalized;
- rate limiting backs off;
- malformed upstream data is rejected safely;
- unsupported capability is explicit;
- provider-specific data normalizes without information loss.

### 24.6 Router integration tests

Prove:

- inference success is not made dependent on usage DB success;
- successful inference can emit UsageEvent metadata;
- quota exhaustion continues to return existing normalized provider errors;
- CMM Usage does not activate fallback/rerouting;
- existing CMM Routers provider/tool tests remain green.

### 24.7 API tests

Prove:

- read-only credential cannot invoke inference;
- inference credential policy remains unchanged;
- summary/detail endpoints expose no secrets;
- provenance/freshness is returned;
- refresh cannot trigger inference.

### 24.8 macOS tests

Use unit/UI tests for:

- provider list;
- multiple buckets per route;
- exhausted/critical/warning/unknown;
- provenance disclosure;
- reset rendering;
- dynamic add/remove visibility;
- cancelled subscriptions excluded from active view but preserved in history.

---

## 25. Initial UX rules

### 25.1 Status semantics

Use textual/icon status plus color; never color alone.

### 25.2 Percentages

Show percentages only when the denominator is known or a provider directly reports a percentage.

### 25.3 Reset

Show absolute reset time in detail and relative reset time in compact UI.

### 25.4 Unknown

Unknown is a first-class state.

Do not display zero or 100% remaining when data is missing.

### 25.5 Constraining quota

Every route/model detail identifies why it is warning/critical/exhausted.

### 25.6 Historical cancellation

Cancelled subscriptions disappear from the active dashboard by default but remain queryable in History/Subscriptions.

---

## 26. Public extensibility

Provider-specific code must remain isolated enough that a future public contributor can add an adapter without reading the entire router.

Each adapter directory must include:

```text
manifest
implementation
fixtures
contract tests
README / supported-source notes
```

Documentation must state whether each value is:

- provider official;
- router measured;
- manual;
- derived;
- estimated.

No adapter may ship with personal provider/account identifiers.

---

## 27. Operational behavior

On CMM Routers startup:

1. initialize UsageStore;
2. verify schema/migrations;
3. load dynamic registry;
4. load enabled adapters;
5. start safe collection scheduler;
6. expose local usage API;
7. keep inference serving even if one usage adapter is degraded.

On shutdown:

1. stop new collection jobs;
2. abort/close safe metadata requests;
3. flush pending usage events;
4. checkpoint/close database;
5. terminate cleanly.

Storage failure is surfaced loudly in diagnostics but must not silently corrupt inference responses.

---

## 28. Phased implementation boundary

The architecture is one product, but implementation must be reviewable in independently testable slices.

### Phase A — Domain + storage foundation

- domain types;
- quota graph;
- storage/migrations;
- registry;
- canonical fixtures.

### Phase B — Usage service + reconciliation + API

- event/snapshot ingestion;
- reconciliation;
- forecasting;
- alerts;
- read API;
- router telemetry bridge.

### Phase C — Generic/manual integrations

- Manual Subscription/API;
- Generic OpenAI-Compatible;
- configuration lifecycle;
- Keychain references.

### Phase D — Provider integrations

- Command Code;
- Qoder;
- Claude;
- Google AI Pro;
- OpenAI;
- DeepSeek.

Each adapter is accepted only when its data source has been verified against current supported provider behavior.

### Phase E — macOS client

- menu bar;
- full window;
- provider/model/quota views;
- alerts;
- subscription management surfaces.

### Phase F — hardening and release

- full regression;
- privacy/security audit;
- no-inference collection proof;
- migration proof;
- public-safe documentation;
- closure evidence.

---

## 29. Acceptance criteria

CMM Usage v1 is complete only when all of the following are true:

1. The quota engine supports many-to-many AccessRoute <-> QuotaBucket relationships.
2. A model may have multiple simultaneous windows and model-specific constraints.
3. A shared quota pool may constrain multiple models.
4. Google AI Pro-style split pools can be represented without provider-specific core branching.
5. Command Code-style global and model-specific limits can coexist.
6. Claude/OpenAI-style rolling and weekly limits can coexist.
7. APIs with one model-specific quota can be represented.
8. APIs with one shared free-model quota can be represented.
9. The same conceptual model may exist through multiple independent access routes.
10. Providers/subscriptions can be added, paused, cancelled, archived, and re-added without schema redesign.
11. Cancellation never deletes history.
12. Generic and manual integrations work without writing a new core adapter.
13. Each displayed value exposes source/confidence/freshness.
14. Unknown and estimated data are visibly distinct from exact data.
15. No collector triggers inference to inspect quota.
16. No prompts or completions enter CMM Usage storage.
17. Credentials remain in Keychain/provider secure storage.
18. SQLite remains machine-local.
19. Forecasting can flag likely exhaustion before reset when sufficient data exists.
20. CMM Usage does not automatically reroute inference in v1.
21. Existing CMM Routers tests remain green.
22. Provider adapter failures do not crash the router.
23. The menu-bar client displays active provider pressure and reset information.
24. The full macOS window exposes Providers, Models, Quotas, History, Costs, Subscriptions, Alerts, and Settings.
25. A new future provider such as Devin can be represented manually immediately and integrated later through an adapter without core redesign.
26. Public-repo output contains no personal credentials, home paths, prompt data, or private account identifiers.

---

## 30. Frozen architectural decisions

The following decisions are frozen for the implementation plan unless a concrete repo/runtime incompatibility is proven:

- CMM Usage lives inside `CMM-Routers`.
- Quotas are modeled as a graph of QuotaBuckets and QuotaBindings.
- ModelIdentity and AccessRoute are separate.
- Provider/account/product/subscription are separate entities.
- Quota windows and metrics are arbitrary/extensible.
- Event and snapshot ingestion coexist.
- Provenance/confidence is mandatory.
- SQLite is local canonical persistence behind `UsageStore`.
- Credentials are stored in Keychain/provider secure storage, not SQLite.
- Adapters are dynamically registered and capability-based.
- Generic OpenAI-Compatible and Manual adapters are first-class.
- Cancelled subscriptions preserve history.
- macOS UI reads a local API rather than the DB.
- v1 observes/forecasts/alerts but does not automatically reroute.
- Collection must never trigger inference solely to learn usage.

Any implementation proposal that violates one of these decisions must stop and present evidence before changing the design.
