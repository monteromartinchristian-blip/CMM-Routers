# CMM Routers ↔ CMM Usage — Canonical Responsibility Boundary

**Date:** 2026-09-15
**Status:** Authoritative architectural clarification
**Repository:** `CMM-Routers`
**Scope:** CMMChat Router, CMM Code Router, shared provider/connection core, CMM Usage, CMMChat integration
**Purpose:** Eliminate ambiguity about ownership of providers, accounts, credentials, models, routes, visibility, execution, quotas and usage data.

---

## 0. Executive rule

The architecture is divided into two different truths:

> **CMM Routers owns connectivity and execution.**
> **CMM Usage owns observability and faithful usage/quota presentation.**

CMM Usage must not become a second provider router, credential store or independent model-routing registry.

CMMChat Router must not become a second quota/usage analytics product.

The two systems cooperate through explicit contracts.

---

# 1. Canonical product responsibilities

| Component | Canonical responsibility |
|---|---|
| **CMM Routers core** | Provider/account registry, secure connection configuration, model discovery, route construction, visibility policy, credential resolution |
| **CMMChat Router** | `CHAT_ONLY` execution of a selected route |
| **CMM Code Router** | `CHAT_AND_TOOLS` execution for coding/agent harnesses |
| **CMM Usage** | Quotas, balances, resets, costs, usage, free/promotional capacity, history, forecasting and alerts |
| **CMMChat** | Chat UI; consumes visible routes from Routers and shows a Usage tab backed by CMM Usage |

The ownership model is:

```text
               CMM Routers core
     ┌────────────────────────────────┐
     │ Provider / account registry    │
     │ Subscriptions / API products   │
     │ Secure credential references   │
     │ Model discovery                │
     │ Access routes                  │
     │ Route visibility               │
     └──────────────┬─────────────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
 CMMChat Router        CMM Code Router
   CHAT_ONLY           CHAT_AND_TOOLS
          │
          │ inference + measured telemetry
          ▼
       Providers
          │
          │ official usage/quota/billing state
          ▼
       CMM Usage
          │
          ├── native CMM Usage app
          └── CMMChat > Usage tab
```

---

# 2. CMM Routers core is the operational source of truth

CMM Routers core owns the facts required to make providers actually usable.

It answers:

- Which providers are supported?
- Which provider accounts/subscriptions/APIs are connected?
- Which secure credential/session belongs to each connection?
- Which models are discoverable through each provider/product?
- Which `AccessRoute` reaches a given model?
- Which routes are globally visible to CMMChat?
- Which route should be executed when CMMChat selects it?

This includes:

```text
Provider
Account
Product / Subscription / API product
Connection instance
Secure credential reference
ModelIdentity
AccessRoute
Route capabilities
Route availability
Route visibility
```

The actual secret material remains in Keychain/provider-secure storage.

CMM Routers stores or resolves **secure references**, not plaintext secrets in normal config/database records.

---

# 3. CMMChat Router

CMMChat Router is the `CHAT_ONLY` execution profile.

Its job is to take a selected canonical route and execute chat inference through it.

Conceptually:

```text
CMMChat
   │
   │ selected routeId
   ▼
CMMChat Router
   │
   ├── resolve provider connection
   ├── resolve credential/session securely
   ├── translate request protocol
   ├── execute inference
   ├── stream output
   ├── cancel
   ├── normalize provider errors
   └── emit measured telemetry
   ▼
Provider
```

CMMChat Router does **not** own:

- quota dashboards;
- balance history;
- Free & Promo analytics;
- cost dashboards;
- reset forecasting;
- usage alerts;
- canonical quota state.

Those belong to CMM Usage.

---

# 4. CMM Code Router

CMM Code Router shares the same provider/route foundation but has the broader:

```text
CHAT_AND_TOOLS
```

execution profile.

It may support:

- tools;
- coding harnesses;
- agent execution;
- tool-call translation;
- tool-capable streaming;
- coding-specific protocol behavior.

It should reuse the same canonical:

- provider registry;
- connections;
- model identities;
- access routes;
- secure credential resolution;

rather than constructing an independent provider universe.

---

# 5. CMM Usage is the observability source of truth

CMM Usage answers:

> **How much AI capacity do I have, how much have I used, what remains, when does it reset, what does it cost, and what free/promotional access is actually available?**

It owns:

```text
QuotaBucket
QuotaBinding
QuotaSnapshot
UsageEvent
CostEvent
Balance state
Reset state
Subscription-period observations
Free/promotional observations
Forecasts
Alerts
Historical usage
```

CMM Usage may query:

1. official provider usage/quota/billing APIs;
2. official account/model metadata;
3. official CLI/app local state;
4. current provider documentation where machine-readable state is unavailable;
5. Router-measured telemetry;
6. carefully labelled manual observations.

It must preserve source, confidence and freshness.

---

# 6. CMM Usage does not own provider connectivity

CMM Usage must not become the canonical owner of:

- API keys;
- OAuth sessions;
- subscription sessions;
- provider connection configuration;
- model routing;
- inference endpoints;
- route visibility policy.

The native CMM Usage app may present actions such as:

```text
Connect OpenRouter
Connect Claude
Add DeepSeek API
Reconnect account
Hide route from CMMChat
```

but those operations delegate to the canonical CMM Routers connection/route services.

CMM Usage may provide the UI.

CMM Routers owns the operational state.

---

# 7. Secure connection management belongs to Routers

The previous idea of a Usage-owned `ConnectionManagementService` is superseded.

The canonical service belongs to CMM Routers/shared provider infrastructure.

Conceptually:

```text
ProviderConnectionService
RouteCatalogService
SecureCredentialResolver
RouteVisibilityStore
```

CMM Usage consumes their safe API.

The normal CMM Usage UI must never receive:

```text
credentialRef
keychain://...
env://...
auth-file paths
plaintext API keys
raw session tokens
```

---

# 8. Route catalog ownership

The canonical selectable catalog belongs to the Routers layer.

It combines:

```text
Provider
Account/Product
ModelIdentity
AccessRoute
Route capabilities
Availability
Visibility
```

CMM Usage enriches this route catalog with:

```text
Quota state
Balance
Usage
Cost
Reset
Offer state
Free / Promo / Included / Trial / PAYG
Freshness
```

This produces a **presentation projection**, but does not transfer route ownership to Usage.

---

# 9. Route visibility belongs to Routers

Global model visibility is operational routing/catalog configuration.

Therefore its canonical owner is the Routers layer.

Visibility remains route-scoped.

Normative example:

```text
Claude Sonnet
├── Anthropic / Claude subscription       Visible
├── Google AI Pro / Antigravity           Visible
└── OpenRouter                            Hidden
```

Expected result:

```text
CMMChat picker
→ Anthropic route appears
→ Google/Antigravity route appears
→ OpenRouter route does not appear
```

But CMM Usage still observes all connected/enabled routes.

Critical invariant:

```text
Hide route != disconnect route
Hide route != stop collection
Hide route != delete accounting
Hide route != hide sibling provider routes
```

---

# 10. Visibility and accounting are orthogonal

The canonical separation is:

```text
Routers RouteVisibilityStore
→ controls what CMMChat can select

Routers connection state
→ controls whether a provider/product is operational

CMM Usage QuotaBinding
→ controls which real quotas affect which routes

CMM Usage snapshots/events
→ represent real provider/account usage
```

Therefore:

```text
Visibility != connection != collection != accounting
```

A hidden OpenRouter Claude route remains visible in CMM Usage accounting if OpenRouter is connected/enabled.

---

# 11. Router telemetry enriches Usage but does not replace provider truth

Routers should emit measurable execution telemetry where useful:

```text
routeId
provider
model identity
timestamp
request result
input tokens, when measured
output tokens, when measured
provider-reported cost, when available
measured/derived cost, when safely calculable
```

CMM Usage may ingest this telemetry.

It must preserve provenance:

```text
provider_official
router_measured
router_derived
manual
```

Provider-official usage remains preferable when available.

Router telemetry is especially useful for per-route attribution when a provider exposes only a shared quota/balance.

---

# 12. Shared pool vs per-route attribution

CMM Usage must distinguish:

```text
Quota applies to route
```

from:

```text
Consumption is attributable to route
```

Example:

```text
OpenRouter shared prepaid balance
$7.31 remaining
```

may affect twenty model routes.

Show the shared pool once.

Do not fabricate twenty independent `$7.31` quotas.

If Routers has measured that a specific route consumed a known amount, Usage may show that as:

```text
Router-measured route consumption
```

without pretending the provider supplied that attribution.

---

# 13. Provider-native quota units are authoritative

CMM Usage is not a money-only product.

It must faithfully represent the provider's native unit.

Valid examples:

```text
61% used
35 credits remaining
80M free-model tokens remaining
30M tokens/day
42 / 100 requests remaining
40 RPM
$0.82 cash balance
$0.00 voucher balance
130 requests
7,676,551 tokens
```

Do not force these into one universal percentage or one currency.

Do not manufacture denominators.

Do not convert percentage-only quotas into tokens.

Do not convert tokens into money without trustworthy pricing evidence and explicit derived labelling.

---

# 14. Real provider state must beat fixtures

This is a critical product rule.

> **When real provider/account state is available, CMM Usage must never substitute invented or plausible fixture data in normal mode.**

The recent visual iteration violated this rule by presenting synthetic values and synthetic providers as if they were real.

Examples of forbidden normal-mode behavior include invented:

```text
15M tokens remaining
24M tokens remaining
68M tokens remaining
82 / 100 promo units
Northstar
Local Lab
synthetic Kira promotions
```

unless they are explicitly marked and isolated as demo/test data.

---

# 15. Demo mode must be impossible to confuse with reality

Fixtures remain valuable for development and tests.

They must be isolated.

Two explicit modes:

```text
NORMAL MODE
→ only real connected/discovered provider state
→ real provider-supported metadata
→ no invented quota values

DEMO / PREVIEW MODE
→ synthetic fixtures allowed
→ visually marked as Demo Data
→ isolated from personal runtime/state
→ never persisted as real provider/account history
```

A demo fixture must never silently appear inside a normal CMM Usage session.

---

# 16. Real data currently visible to the development environment

The current Safari/browser environment contains real authenticated provider surfaces that may be inspected through authorized Computer Use.

Examples supplied by the user include:

## DeepSeek

Real surface exposes:

- topped-up balance;
- total cost;
- API requests;
- tokens;
- usage by API key/model/time.

## OpenRouter

Real surface exposes:

- API key state;
- key usage;
- key limit;
- account credits/balance;
- models and routing state.

## NVIDIA NIM

Real surface exposes:

- account/API key;
- account rate limit;
- free API endpoints;
- model catalog/capabilities.

## TokenRouter

Real surface exposes:

- cash balance;
- voucher/promotional balance;
- total spend;
- requests;
- total tokens;
- RPM;
- TPM;
- model-consumption views;
- promotional/free offers.

## Token Harbor

Real surface exposes:

- free allowance;
- reset timing;
- free model catalog;
- offers/top-up rewards;
- account API-key state.

## Kira AI

Real surface shows current account-level free-token state and current free-model metadata.

At the time captured by the user, the visible surfaces included:

```text
Kira Model Tokens Remaining: 50,000 tokens
Free Model Tokens Remaining: 80,000,000 tokens
Checked in: +50M tokens
```

The free-model catalog also visibly described multiple free models with per-model free allowance semantics such as:

```text
Free 30M tokens/day
```

These screenshots are evidence for implementation/discovery research, not values to hardcode as permanent policy.

## Cavoti AI

Real surface exposes:

- account/key status;
- current balance/limit;
- usage percentage;
- API endpoint/account state.

## Command Code GOAT

Real official surfaces expose:

- current account usage;
- 5-hour usage window;
- weekly usage window;
- monthly usage;
- GOAT plan semantics;
- per-model effective credit/pricing behavior;
- free/deal model catalog.

Visible official plan documentation includes:

```text
5-hour limit: $14 of usage
Weekly limit: $35 of usage
Monthly limit: $70 of usage
```

and model-dependent effective request counts.

Again: use current provider evidence dynamically; do not hardcode documentation screenshots as eternal truth.

## Vikey and other providers

Where real account/API state is available, inspect and normalize the real provider semantics rather than inventing representative product state.

---

# 17. Computer Use policy for provider discovery

Authorized browser/desktop inspection may be used to understand:

- current provider quota semantics;
- free model lists;
- account balances;
- rate limits;
- reset behavior;
- pricing/credit mechanics;
- model availability;
- provider UI terminology.

Do not:

- copy secrets into source code;
- print full API keys into logs;
- persist browser session tokens in fixtures;
- hardcode private account values;
- treat a screenshot as permanent provider policy.

Use authenticated sessions as an evidence/discovery source and connect providers through the secure Routers flow.

---

# 18. CMM Usage native app

The native CMM Usage app is a dedicated observability UI.

It may expose:

```text
Overview
Quotas
Models
Providers
Free & Promo
History
Costs
Alerts
Settings
```

but these pages must be driven by:

```text
Routers real connection/catalog state
+
Usage real normalized observations
```

not by synthetic product fiction.

`Providers` inside Usage is a management/projection UI over CMM Routers provider connections.

It is not an independent provider registry.

---

# 19. CMMChat > Usage tab

CMMChat should embed a Usage surface backed by the same CMM Usage service.

It should not reimplement quota logic.

Conceptually:

```text
CMM Usage service
       ├── native CMM Usage app
       └── CMMChat Usage tab
```

The same normalized quota/balance/reset/free-access state powers both surfaces.

---

# 20. CMMChat active chat remains clean

CMMChat's active conversation UI should use:

```text
Routers visible route catalog
```

for model selection.

It may show a compact access label such as:

```text
Included
Free
Promo
PAYG
```

where useful.

It should not continuously clutter chat with:

- detailed balances;
- reset timestamps;
- full quota graphs;
- usage history.

Those belong in the Usage tab.

---

# 21. Canonical storage separation

## CMM Routers stores operational configuration

Examples:

```text
connected provider instances
account/product relationships
secure credential references
model discovery metadata
route definitions
route visibility
execution configuration
```

## CMM Usage stores observability/history

Examples:

```text
quota snapshots
balance snapshots
usage events
cost events
reset observations
promotion observations
forecast state
alert state
```

These databases/services must not silently assume ownership of the other's data.

---

# 22. Dependency direction

The intended dependency is:

```text
CMM Routers core
       │
       ├── connection/catalog API
       │
       ▼
CMM Usage
       │
       ├── quota/usage API
       │
       ▼
CMMChat Usage tab
```

For inference:

```text
CMMChat
   │
   ▼
CMMChat Router
   │
   ▼
Provider
```

For measured telemetry:

```text
CMMChat Router
   │
   ▼
CMM Usage
```

Avoid circular ownership.

---

# 23. Shared contracts that should be frozen

Before broadening implementation, freeze safe contracts for:

## Provider/connection catalog

```text
ProviderDirectoryEntry
ConnectedProviderInstance
Product/Subscription metadata
```

## Route catalog

```text
ModelIdentity
AccessRoute
RouteAvailability
RouteCapabilities
RouteVisibility
```

## Usage enrichment

```text
QuotaSummary
BalanceSummary
ResetSummary
CostSummary
AccessOffer
Freshness
Provenance
```

CMM Usage may join/project these contracts but does not redefine provider connection ownership.

---

# 24. Immediate implementation correction

The current CMM Usage redesign should stop treating fixtures as the main product data source.

The next correction is:

1. preserve useful UI/domain work already completed;
2. remove or isolate synthetic provider/account data from normal mode;
3. consume real CMM Routers provider/catalog state;
4. use real provider metadata/usage adapters;
5. use Computer Use only as authorized discovery/verification where direct machine-readable integration is incomplete;
6. show `Not connected` / `Unknown` rather than invent data;
7. keep Demo Mode explicitly marked.

---

# 25. CMMChat Router pause/resume rule

CMMChat Router should remain paused only until this responsibility boundary and the shared provider/route contracts are frozen.

After that, it becomes useful to resume it because CMM Usage should consume real provider/route state rather than continuing to invent a parallel catalog.

The recommended sequence is:

```text
1. Commit this responsibility boundary
2. Freeze ProviderConnection + RouteCatalog contracts
3. Resume CMMChat Router/shared Routers core
4. Make real provider/account/model routes canonical
5. Point CMM Usage at that real catalog
6. Finish CMM Usage visual redesign using real data
7. Expose the same Usage service in CMMChat
```

This does **not** mean completing the entire CMMChat Router before returning to Usage.

Only the shared operational foundation needs to stabilize first.

---

# 26. Non-negotiable invariants

The following statements are architectural law:

```text
Routers owns connectivity.
Routers owns secure provider configuration.
Routers owns model discovery.
Routers owns AccessRoute.
Routers owns route visibility.
Routers executes inference.

Usage owns quota normalization.
Usage owns balances.
Usage owns resets.
Usage owns usage/cost history.
Usage owns free/promo observability.
Usage owns forecasts and alerts.

CMMChat consumes routes from Routers.
CMMChat Usage tab consumes Usage.

Visibility does not change accounting.
Hidden routes remain observable.
Shared quotas are not duplicated.
Unknown is better than invented.
Real state beats fixtures.
Demo data must be unmistakably demo data.
```

---

# 27. Definition of architectural success

This clarification is correctly implemented when:

1. CMMChat Router can connect and execute real provider routes without depending on CMM Usage.
2. CMM Usage can observe and present real quota/usage state without owning inference routing.
3. CMM Usage can show provider management without duplicating credential/connection ownership.
4. CMMChat receives its selectable route catalog from Routers.
5. CMMChat's Usage tab and the standalone Usage app read the same Usage service.
6. Hidden routes disappear from CMMChat but remain visible in Usage accounting.
7. Provider-native units remain faithful.
8. Shared pools remain shared.
9. Real authenticated provider state is preferred over synthetic fixtures.
10. Fixtures are isolated to explicit Demo/Preview mode.
11. No plaintext secrets leak into Usage DTOs, fixtures, logs or source.
12. The system can add new providers without creating a second parallel provider universe inside CMM Usage.

---

# 28. Final architectural statement

The simplest correct mental model is:

> **CMM Routers makes AI providers usable.**
> **CMM Usage tells the truth about how much of that AI access exists, remains, costs and resets.**
> **CMMChat consumes both: Routers for execution, Usage for observability.**

Keep that boundary intact.
