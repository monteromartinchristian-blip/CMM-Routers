# CMM Usage — Product Redesign, Provider Catalog & Hermes-Parity UX

**Date:** 2026-09-14
**Revision:** v2 — route-scoped visibility + provider-native quota accounting
**Status:** Frozen design direction for implementation
**Accepted baseline:** `9a9d5604547224eb7ed4e1f511d2a5e202c3785a`
**Target:** Native macOS CMM Usage + reusable catalog surface for CMMChat
**Visual reference:** the six Hermes Desktop screenshots supplied with this design.

## 0. Executive decision

The CMM Usage backend/runtime is accepted as a strong foundation. The current first-pass macOS client is **not accepted as the product**.

CMM Usage must become a polished native macOS application whose provider/model management is deliberately very close to the supplied Hermes references while going materially further in quota intelligence, subscriptions/APIs, free and promotional access, secure connection management, model visibility, and reusable catalog integration with CMMChat.

Do not stop merely because Swift compiles, tests pass, the API responds, or a window renders. The redesign is complete only when the app is visually coherent, information-rich, pleasant to use, and strong enough to place next to the Hermes references without embarrassment.

Preserve the proven quota engine, canonical graph, adapters, SQLite persistence, runtime and local API. Extend them only where this product layer genuinely requires it.

---

# 1. Product thesis

CMM Usage answers:

> **What AI access do I have right now, through which subscriptions and APIs, what can I use, what is free or included, what does it cost, and what limits remain?**

It is not merely a quota monitor. It is the local source of truth for:

- providers;
- subscription products;
- API products;
- connected accounts;
- custom endpoints;
- accessible models;
- selectable access routes;
- Free / Promo / Included / Trial / PAYG access;
- balances;
- quota windows;
- resets;
- costs;
- freshness;
- visibility preferences.

CMMChat should consume this source of truth instead of maintaining its own provider/model catalog.

Two invariants are now explicit and non-negotiable:

1. **Visibility is route-scoped.** Hiding Claude through OpenRouter must not hide Claude through Anthropic direct or Google AI/Antigravity.
2. **Visibility never changes accounting.** Hidden routes remain fully represented in CMM Usage quotas, history and costs whenever the connected provider exposes that data.

---

# 2. What to preserve from Hermes

The supplied Hermes screenshots validate four interaction patterns that CMM Usage should intentionally reproduce.

## 2.1 Connected and available providers together

Hermes shows both configured and not-yet-connected options. CMM Usage must also make supported providers discoverable before connection.

## 2.2 Separate connection types

Preserve a clear distinction between:

- accounts/subscriptions;
- API keys;
- custom OpenAI-compatible endpoints;
- local models.

Normal users must never need to understand `credentialRef`, `env://`, `keychain://`, internal integration IDs or JSON config files.

## 2.3 Searchable provider-grouped model visibility

Match the Hermes model editor pattern:

- search;
- provider/product grouping;
- per-model toggle;
- group toggle;
- mixed state;
- visible/hidden curation;
- direct `Add provider...`.

## 2.4 Compact picker from the same catalog

The CMMChat picker must later consume the same curated catalog and expose `Edit models...` as a direct route into global visibility management.

---

# 3. Where CMM Usage must surpass Hermes

Every selectable route may carry operational semantics:

- `FREE`
- `PROMO`
- `INCLUDED`
- `TRIAL`
- `PAYG`
- `UNKNOWN`

and, when known:

- limit;
- used;
- remaining;
- reset;
- cadence;
- price;
- promotional validity;
- source;
- confidence;
- freshness;
- availability.

Example:

```text
Qwen 3.8 Flash
Kira AI
FREE
438 / 500 requests remaining
Resets in 6h 21m
Updated 2m ago
Visible in CMMChat
```

If the provider does not expose a limit:

```text
Qwen 3.8 Flash
Kira AI
FREE
Limit not reported
Provider confirmed
Visible in CMMChat
```

Never invent missing allowances for visual completeness.

---

# 4. Architecture

```text
Provider adapters / discovery
            │
            ▼
Canonical CMM Usage Domain
Provider · Account · Product · SubscriptionPeriod
ModelIdentity · AccessRoute
QuotaBucket · QuotaBinding · Snapshot
            │
            ▼
PresentationCatalogService
            │
            ├── ProviderDirectory
            ├── Catalog projection
            ├── AccessOffer projection
            ├── QuotaSummary projection
            └── VisibilityStore
            │
            ├───────────────┐
            ▼               ▼
       CMM Usage          CMMChat
       native UI          model picker
                          Usage tab
```

Connection mutation is separate:

```text
CMM Usage UI
    │
    ▼
ConnectionManagementService
    │
    ├── Keychain / secure storage
    ├── internal integration configuration
    └── runtime reload / refresh
```

The UI never receives raw secure credential references.

---

# 5. Canonical identity vs presentation identity

Canonical backend IDs remain stable and machine-oriented:

```text
individual-goat
provider:command-code
product:command-code:individual-goat
model:qwen:...
```

These must not appear in normal UI.

Presentation metadata owns:

- provider display name;
- product/plan display name;
- model display name;
- metric label;
- unit formatting;
- quota/window label;
- connection copy;
- explanatory status.

Example:

```text
canonical product id: individual-goat
display name: GOAT
provider: Command Code
category: Subscription
```

Do not mutate canonical IDs to make UI prettier.

---

# 6. ProviderDirectory

`ProviderDirectory` represents what CMM Usage knows how to connect, whether or not it is currently configured.

Conceptual safe DTO:

```ts
type ProviderDirectoryEntry = {
  integrationType: string
  displayName: string
  shortDescription?: string
  iconKey?: string

  category:
    | "subscription"
    | "api"
    | "aggregator"
    | "custom_endpoint"
    | "local"

  connectionMethods: Array<
    | "account"
    | "oauth"
    | "api_key"
    | "local_session"
    | "custom_endpoint"
  >

  state:
    | "available"
    | "connecting"
    | "connected"
    | "degraded"
    | "disabled"
    | "reauth_required"
    | "unavailable"

  connectedInstanceCount: number

  capabilities: {
    modelDiscovery: boolean
    quotaDiscovery: boolean
    balanceDiscovery: boolean
    costDiscovery: boolean
    pricingDiscovery: boolean
  }
}
```

Invariant:

```text
supported != connected != enabled != healthy
```

---

# 7. ConnectionManagementService

This service owns provider-connection mutation.

Conceptual operations:

```text
connectAccount(integrationType)
connectWithApiKey(integrationType, secret)
addCustomEndpoint(...)
disconnect(instanceId)
enable(instanceId)
disable(instanceId)
reauthenticate(instanceId)
testConnection(instanceId)
refresh(instanceId)
```

Rules:

1. Submitted secrets are stored securely immediately.
2. UI receives no Keychain URL.
3. UI receives no `credentialRef`.
4. UI receives no arbitrary adapter settings JSON.
5. Disconnecting preserves historical usage by default.
6. Reconnection preserves canonical identity where appropriate.
7. Runtime reload/reconfiguration is automatic.

Safe display may show:

```text
OpenRouter
Connected
Key •••• a4f1
```

Never the whole secret.

---

# 8. Connection UX

## Accounts / subscriptions

```text
Connect an account

Connected
────────────────────────────────────────
Command Code                  ✓ Connected
GOAT

ChatGPT / Codex              ✓ Connected

Available
────────────────────────────────────────
Claude                        Connect →
Google AI Pro                 Connect →
Qwen Token Plan              Connect →
```

Prefer one-click reuse of safe local authenticated sessions where supported.

## API providers

```text
API providers

OpenRouter               Connected      •••• a4f1
DeepSeek                 Add API key →
OpenAI API               Add API key →
Anthropic API            Add API key →
Qwen Model Studio        Add API key →
```

## Custom endpoint

Take strong interaction inspiration from Hermes.

Fields:

- Name
- Endpoint URL
- Default model
- Context when useful
- API key
- Discover models
- Use in CMMChat
- Test
- Save

CMM improvements:

- optional Usage metadata endpoint;
- optional Billing metadata endpoint;
- quota mode: Automatic / Manual / Unknown;
- connection-health status.

OpenAI compatibility does not imply standardized billing support.

---

# 9. PresentationCatalogService

This is the only source of truth for product-facing catalog data.

It projects:

- canonical Usage domain;
- presentation metadata;
- ProviderDirectory;
- visibility preferences.

Do **not** reuse `ProviderRegistry.listModels()` as the product catalog. That registry models inference transport and lacks products, accounts, quotas, connection state, supported-but-unconnected providers, offers and visibility policy.

---

# 10. Selectable unit: AccessRoute, not ModelIdentity

The same conceptual model may be selectable through several routes:

```text
Qwen 3.8 Max
via Qwen Token Plan
Included

Qwen 3.8 Max
via Qwen Model Studio
PAYG

Qwen 3.8 Max
via OpenRouter
Promo
```

These can share `ModelIdentity` while remaining operationally distinct.

CMMChat must select a route even if the compact picker emphasizes the model name.

This becomes especially important for models available through several providers:

```text
Claude Sonnet
├── Anthropic / Claude subscription       ✓ Visible
├── Google AI Pro / Antigravity           ✓ Visible
└── OpenRouter                            ○ Hidden
```

The hidden OpenRouter route must not alter the visibility of the other Claude routes.

**Critical invariant:**

```text
Hide route != hide conceptual model everywhere
```

If a future UI offers an explicit `Hide this model everywhere` action, it must be a distinct user action that resolves to route-level preferences. It must never be the implicit effect of hiding one provider route.

---

# 11. CatalogRouteEntry

Conceptual safe DTO:

```ts
type CatalogRouteEntry = {
  routeId: string
  modelIdentityId: string

  provider: {
    id: string
    displayName: string
    iconKey?: string
  }

  product: {
    id: string
    displayName: string
    category: "subscription" | "api" | "aggregator" | "custom" | "local"
  }

  model: {
    id: string
    displayName: string
    family?: string
    capabilities?: string[]
  }

  offer: AccessOfferSummary
  quota: QuotaSummary
  pricing?: PricingSummary

  availability:
    | "available"
    | "temporarily_unavailable"
    | "unknown"

  visibility:
    | "visible"
    | "hidden"

  freshness?: {
    observedAt?: string
    stale: boolean
  }
}
```

No credentials. No raw auth state. No arbitrary adapter settings.

---

# 12. AccessOffer semantics

Use only these primary categories.

## FREE

Current access has no metered monetary usage cost and no temporary promotional end is known. It may still have quota.

## PROMO

Temporary free or specially discounted access compared with normal commercial state.

## INCLUDED

Usage is covered by a paid subscription/product the user already has.

A paid subscription is not `FREE`.

## TRIAL

Initial trial, initial credit grant or explicitly temporary evaluation entitlement.

## PAYG

Metered usage incurs cost.

## UNKNOWN

Commercial semantics are not safely established.

Optional modifiers:

```text
discounted
byok
sharedPool
```

Do not create a new primary category for every provider nuance.

---

# 13. Offer and quota remain separate

```text
AccessOffer = why/how access is available
QuotaBucket = how much can be used
```

Example:

```text
Offer: PROMO

Quota:
100 requests/day
42 remaining
reset 00:00 UTC

Validity:
ends 30 Sep 2026
```

The commercial category must never dictate the quota unit.

A `FREE`, `PROMO`, `INCLUDED`, `TRIAL` or `PAYG` route may be constrained by any provider-native metric.

---

# 13.1 Provider-native quota metrics are first-class

CMM Usage must **not** force heterogeneous provider quotas into money, credits, tokens, or percentages.

The quota engine and presentation layer must preserve the metric actually reported by the provider.

Supported examples include:

```text
Currency / monetary balance
Credits
Input tokens
Output tokens
Total tokens
Requests
Calls
Compute units
Provider-defined units
Percentage utilization
Percentage remaining
Shared pool balance
Rate limit
Time/window-only constraint
```

Examples of equally valid quota presentations:

```text
OpenRouter
$7.31 credit balance remaining
```

```text
Command Code
35 credits remaining
```

```text
Google AI Pro
1.2M / 2M tokens used
```

```text
Claude
27% used
Weekly window
```

```text
Free model
42 / 100 requests remaining
Resets at 00:00 UTC
```

A percentage-only provider must remain percentage-only unless an absolute denominator is actually known.

If the provider reports:

```text
27% utilization
```

CMM Usage may optionally derive:

```text
73% remaining
```

only as a clearly derived presentation value. It must not manufacture token, request, credit or monetary absolutes.

Likewise, a token quota must not be converted to money unless there is a separately trustworthy pricing/cost basis and the UI explicitly presents the conversion as derived.

---

# 13.2 Quota scope and attribution are first-class

Every quota/balance must preserve its real scope.

Possible scopes include:

```text
provider-wide
account-wide
product/subscription
shared pool
model-specific
AccessRoute-specific
API-key-specific
workspace/member-specific
```

CMM Usage must never duplicate a shared pool as if each model had an independent copy of the same allowance.

If a provider exposes:

```text
OpenRouter shared credits
$7.31 remaining
```

and that pool constrains:

```text
Claude Sonnet
DeepSeek V4.1 Flash
Qwen ...
```

the UI should show the shared pool once and indicate the affected routes.

Do not fabricate:

```text
Claude Sonnet: $2.11 used
DeepSeek: $1.73 used
```

unless the provider or trusted router telemetry actually attributes those amounts.

If router telemetry can attribute consumption to a route, show that attribution separately with its own measured provenance.

---

# 14. Free and promotional discovery

Recognize free/promotional access only from trustworthy evidence.

Preference:

1. official quota/billing metadata;
2. official model/account metadata;
3. official CLI/app state;
4. current official docs;
5. manual observation.

Preserve:

```text
source
confidence
observedAt
validUntil?
```

Promotional state is refreshable and temporal.

Potential product events:

```text
New free model available
Promotion ending soon
Free quota exhausted
Free quota reset
```

No noisy notifications by default.

---

# 15. Visibility model

Frozen decision:

> **Global visibility is canonical in v1. Workspace/profile overrides are a future extension.**

Here, **global** means the preference is shared between CMM Usage and CMMChat rather than being workspace-specific.

It does **not** mean that visibility applies to every provider route of the same `ModelIdentity`.

Visibility is route-scoped.

Prepare the data model now:

```ts
type VisibilityPreference = {
  scope: "global" | `workspace:${string}`
  providerId?: string
  productId?: string
  routeId?: string
  state: "visible" | "hidden" | "inherit"
}
```

Example:

```text
Claude Sonnet
Anthropic direct                 Visible
Google AI Pro / Antigravity      Visible
OpenRouter                       Hidden
```

All three routes may share the same conceptual `ModelIdentity`.

Only the OpenRouter route disappears from normal CMMChat model-selection surfaces.

Future resolution:

```text
workspace route override
          ↓
global route preference
          ↓
provider/product group preference
          ↓
product default
```

v1 reads/writes only `global`.

A provider-level/group toggle affects only routes inside that provider/product group.

---

# 15.1 Visibility and accounting are orthogonal

**Visibility is a presentation preference only.**

Hiding an `AccessRoute` from CMMChat or from the normal model picker MUST NOT:

- disable provider collection;
- stop quota refresh;
- delete `QuotaBinding`s;
- suppress snapshots;
- suppress historical consumption;
- suppress cost information;
- alter provider/product totals;
- remove the route from CMM Usage quota/accounting views;
- rewrite canonical identities.

Collection is controlled by integration connection/enabled state.

Picker visibility is controlled by `VisibilityStore`.

Accounting is controlled by the canonical Usage domain:

```text
VisibilityStore
→ what appears in model-selection surfaces

QuotaBinding
→ which real quota constrains which routes

QuotaSnapshot
→ current provider-reported quota state

UsageEvent / CostEvent
→ attributable real consumption when available
```

These systems must never be conflated.

---

# 16. Group visibility

Match Hermes:

```text
✓ all visible
− partially visible
○ all hidden
```

The storage implementation may use group defaults plus exceptions for large catalogs. The interaction behavior is required.

---

# 17. Model editor

This should be one of the strongest screens in the app.

Required:

- instant search;
- provider/product grouping;
- friendly names;
- group mixed-state control;
- per-model toggle;
- access badges;
- headline quota/access information;
- keyboard navigation;
- compact density;
- `Add provider...`.

CMM improvement:

```text
OPENROUTER
✓ DeepSeek V4.1 Flash        FREE       100 req/day
✓ GLM ...                    PROMO      Ends Sep 30
○ Claude Sonnet              PAYG       $...
```

Full quota detail belongs in model/route detail, not every list row.

---

# 18. CMMChat picker

Consume the exact same visible catalog.

Target interaction:

```text
QWEN TOKEN PLAN
Qwen 3.8 Max                  Included
Qwen 3.7 Max                  Included

OPENROUTER
DeepSeek V4.1 Flash           Free
GLM ...                       Promo

Edit models...
```

Do not clutter active chat with detailed remaining quota, reset timers, source or confidence.

Detailed operational data belongs in CMM Usage and the future CMMChat Usage tab.

---

# 19. Main information architecture

The rejected first client mirrored backend entities too literally.

Recommended primary navigation:

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

`Quotas` is intentionally explicit: this is the authoritative operational view across credits, tokens, requests, percentages, monetary balances and provider-defined metrics.

Pages can be conditionally omitted or visually de-emphasized when they have no useful content.

Never show a dead empty page only because the backend has a corresponding entity.

---

# 20. Overview

Overview answers in seconds:

- what is connected;
- what is close to exhaustion;
- what resets soon;
- what free/promotional access exists;
- what is degraded;
- what needs attention.

Representative composition:

```text
CMM Usage

Subscriptions
────────────────────────────────────────
Command Code · GOAT
Monthly      35 credits remaining
5-hour       14 / 14
Weekly       35 / 35
Renews       7 Oct

Claude
Not connected                                  Connect →

APIs
────────────────────────────────────────
OpenRouter
Not connected                                  Add API key →

DeepSeek
Not connected                                  Add API key →

Free & promotional
────────────────────────────────────────
✨ Qwen 3.8 Flash · Kira AI
FREE · 500 req/day                             Connect →

✨ DeepSeek V4.1 Flash · ...
PROMO · Ends 30 Sep                            Connect →
```

The exact arrangement may evolve, but the information density must meet this level.

---

# 21. Quotas

This is the authoritative operational accounting surface.

It must reflect the **real provider-native consumption semantics** of every connected/enabled integration, regardless of whether any associated model routes are hidden from CMMChat.

Group primarily by provider/product/account, with optional alternate views by:

```text
By provider
By subscription / API product
By model / route
Shared pools
```

Every connected product can show:

- friendly provider/product name;
- connection/collection health;
- primary constraining bucket;
- all applicable quota windows;
- metric and native unit;
- used;
- remaining;
- limit when known;
- reset/cadence;
- freshness;
- forecast when meaningful;
- real scope: product/shared/model/route/key/etc.;
- routes affected by shared pools.

The UI must adapt to provider-native metrics.

### Credits

```text
Command Code · GOAT

Monthly plan
35 credits remaining
Renews 7 Oct
Primary constraint

5-hour window
14 / 14 provider units remaining
Reset time not reported

Weekly window
35 / 35 provider units remaining
Reset time not reported

Supplemental balances
Purchased   0 credits
Free        0 credits
```

Supplemental balances must not masquerade as hard constraints.

### Percentage-only

```text
Claude subscription

5-hour window
27% used
Reset 21:14

Weekly
61% used
Reset Monday 09:00

Absolute tokens / requests
Unknown
```

Do not invent absolute units.

### Tokens

```text
Google AI Pro

Claude pool
1.2M / 2M tokens used
800K remaining
Resets 00:00 UTC
```

### Requests

```text
Promotional model

Daily allowance
58 / 100 requests used
42 remaining
Resets in 6h 21m
```

### Monetary / credit pool

```text
OpenRouter

Shared prepaid pool
$7.31 remaining

Constrains 12 visible/hidden routes
```

If the provider does not expose model-specific spend, do not fabricate it.

Unknown must look intentional.

---

# 21.1 Hidden routes remain visible in Quotas

Example:

```text
Claude Sonnet
├── Anthropic / Claude subscription       Visible in picker
├── Google AI Pro / Antigravity           Visible in picker
└── OpenRouter                            Hidden in picker
```

`Quotas` must still represent the real state of all three connected routes/products.

Possible display:

```text
Claude subscription
Weekly utilization        61% used

Google AI Pro
Shared Claude token pool  1.2M / 2M tokens

OpenRouter
Shared prepaid credits    $7.31 remaining
Applies to Claude Sonnet and other OpenRouter routes
```

Hiding the OpenRouter route changes only model selection.

It does not erase or suppress OpenRouter accounting.

---

# 21.2 Do not over-attribute consumption

CMM Usage should distinguish:

```text
Quota applies to route
```

from:

```text
Consumption is attributable to route
```

A shared quota can constrain many routes even when the provider cannot tell us exactly how much each route consumed.

Only show per-model/per-route consumption when:

1. the provider reports it; or
2. trusted router telemetry measures it.

When attribution is router-measured rather than provider-reported, preserve and expose that provenance in detail views.

---

# 22. Models

This is the full route catalog.

Core filters:

```text
All
Included
Free
Promo
Trial
PAYG
Hidden
```

Optional filters:

- provider;
- product;
- capability;
- connected only;
- available only.

Each row/card shows:

- model friendly name;
- provider;
- product/route;
- access badge;
- headline quota or price;
- visibility;
- freshness if relevant.

---

# 23. Providers

Strongly reuse the Hermes mental model.

Recommended internal segmentation:

```text
Accounts
API Keys
Custom Endpoints
Local Models
```

Supported-but-unconnected options remain visible.

Local Models is future-ready and does not need to block this redesign if inventory is not yet wired.

---

# 24. Free & Promo

This is a first-class CMM improvement.

Purpose:

> Surface valuable AI capacity the user may not know they have.

Sections may include:

- New free access;
- Active free routes;
- Active promotions;
- Expiring soon;
- Exhausted until reset;
- Available but provider not connected.

Example:

```text
NEW
Qwen 3.8 Flash
Kira AI
FREE
500 req/day
Connect →

DeepSeek V4.1 Flash
OpenRouter
PROMO
100 req/day
Ends 30 Sep
```

This must feel useful, not like advertising.

No sponsored placement and no provider favoritism.

---

# 25. History

Only make History prominent when useful.

Possible content:

- quota evolution;
- balance evolution;
- resets;
- exhaustion events;
- provider availability changes;
- promotion changes.

If discrete events are unavailable, snapshot history is preferable to an empty screen.

---

# 26. Costs

Only show costs where real cost data exists.

Costs are **not** the universal quota abstraction.

Many providers expose quotas in:

- tokens;
- credits;
- requests;
- percentages;
- provider-defined units;
- shared allowance windows;

with no monetary interpretation.

Possible cost summaries, only when supported:

- billing cycle;
- provider spend;
- route/model spend;
- PAYG cost;
- prepaid monetary credits.

Unavailable cost is `Unknown`, never zero.

Do not convert token/credit/request quotas into money merely because a Costs page exists.

---

# 27. Alerts

Useful alert types:

- quota below threshold;
- predicted exhaustion before reset;
- promotion ending;
- free quota reset;
- auth needs attention;
- provider degraded.

Defaults should remain restrained.

---

# 28. Menu bar

The menu bar must be useful within seconds.

Representative structure:

```text
CMM Usage

Command Code · GOAT
Monthly                 35 credits
5-hour                  14 / 14
Weekly                  35 / 35

OpenRouter
Healthy                 ...

────────────────────
Free & Promo            2 available
Refresh
Open CMM Usage
```

Rules:

- friendly names only;
- no canonical IDs;
- no fake universal aggregate;
- warnings are obvious;
- reset/renewal shown when useful;
- compact density.

---

# 29. Visual direction

The finished product should be **visually very close in quality and interaction discipline to the supplied Hermes references**, not merely functionally inspired.

Use those screenshots as normative reference for:

- dark macOS aesthetic;
- crisp hierarchy;
- restrained chrome;
- thin/subtle borders;
- compact settings rows;
- clear connected badges;
- search placement;
- modal/panel proportions;
- provider grouping;
- toggle treatment;
- quiet secondary text;
- dense but calm lists.

CMM Usage should improve on Hermes with richer operational visualization.

---

# 30. CMM visual improvements over Hermes

Do not produce “Hermes plus more text”.

## Quota visualization

Use progress bars/rings only when the denominator is real.

Never draw a percentage bar from an unknown ceiling.

## Reset treatment

Visually distinguish:

```text
Resets in 3h 42m
Mon 09:00
No reset
Unknown
```

## Access badges

Use compact, consistent badges:

```text
FREE
PROMO
INCLUDED
TRIAL
PAYG
```

They should be distinct but restrained.

## Freshness

Stale data should be noticeable without appearing catastrophic unless trust is materially affected.

## Primary constraint

The actual constraining quota should be visually prominent.

Supplemental/non-constraining balances should be subordinate.

---

# 31. Native design system

Create reusable SwiftUI primitives for:

- app/sidebar navigation;
- section headers;
- provider identity;
- connected-state badges;
- access badges;
- quota rows;
- progress bars;
- reset labels;
- metric formatting;
- empty states;
- provider cards;
- model rows;
- visibility toggles;
- search fields;
- connection rows;
- warning banners;
- detail sheets;
- destructive confirmation.

Avoid a generic web-dashboard aesthetic.

Avoid excessive gradients, giant cards, gratuitous rounded rectangles and decorative charts with little value.

---

# 32. Typography and density

Follow the strongest aspect of the Hermes screenshots: dense without cramped.

Use:

- strong title hierarchy;
- subdued metadata;
- numeric alignment where useful;
- consistent row heights;
- clear group spacing;
- compact secondary labels.

Do not turn every quota into a giant tile.

This is a desktop power-user product.

---

# 33. Empty states

No dead empty panes.

Examples:

```text
No API providers connected
Connect OpenRouter, DeepSeek, OpenAI API, or another supported provider.
[ Add API provider ]
```

```text
No cost data available
Command Code does not currently expose durable cost events through this integration.
```

```text
No models discovered yet
Refresh the provider or review its connection.
```

Every empty state explains what is missing, why when known, and what the user can do next.

---

# 34. Friendly formatting

Normal UI must never expose raw implementation vocabulary where a human label exists.

Examples:

```text
individual-goat → GOAT
```

Internal metric/source enums belong in diagnostics.

Presentation formatting should support:

- singular/plural;
- sensible decimals;
- utilization percentages;
- remaining percentages;
- currency;
- credits;
- input/output/total tokens;
- requests/calls;
- compute/provider-defined units;
- shared balances;
- absolute dates;
- relative reset times;
- `No reset`;
- `Unknown reset`.

The presentation layer must select formatting from the bucket's native metric/unit rather than from provider-specific hardcoded assumptions.

---

# 35. Status semantics

Avoid one giant `Unknown` when partial knowledge is useful.

Presentation may distinguish:

```text
Connection health
Quota pressure
Commercial state
Freshness
```

Example:

```text
Connected
Hard windows healthy
Monthly balance known
Monthly ceiling not reported
```

Do not invent the monthly GOAT ceiling from static CLI knowledge unless introduced deliberately with provenance.

---

# 36. Real Command Code dogfood fixture

Create a public-safe representative fixture based on the proven topology:

- Command Code;
- GOAT;
- monthly plan balance;
- purchased supplemental balance;
- free supplemental balance;
- 5-hour window;
- weekly window;
- subscription period;
- missing current reset instants for 5h/weekly;
- no current org/model-specific constraints.

Do not commit actual user values/account information.

The revised UI must make this topology useful and understandable.

---

# 37. Security boundary

Normal UI must not expose:

- `credentialRef`;
- Keychain URLs;
- env variable references;
- auth file paths;
- raw account IDs;
- raw canonical IDs except explicit diagnostics;
- arbitrary adapter JSON.

Keep read and mutation authority separate:

```text
Usage/catalog read token
→ safe reads

Connection-management authority
→ Keychain writes
→ enable/disable
→ connection mutation
```

CMMChat should not automatically receive provider-secret mutation authority.

---

# 38. Safe product-facing API

Add safe DTO endpoints as needed.

Conceptual reads:

```text
GET /v1/cmm/usage/catalog/providers
GET /v1/cmm/usage/catalog/routes
GET /v1/cmm/usage/catalog/routes/:id
GET /v1/cmm/usage/catalog/promotions
GET /v1/cmm/usage/catalog/visibility
```

Conceptual privileged mutations:

```text
POST /v1/cmm/usage/connections/...
PATCH /v1/cmm/usage/connections/:id
DELETE /v1/cmm/usage/connections/:id
PATCH /v1/cmm/usage/catalog/visibility
```

Follow existing API conventions where appropriate.

Do not simply reuse the current read-only Usage token for secret mutation.

---

# 39. CMMChat contract

CMMChat later consumes:

- connected providers;
- visible routes;
- friendly labels;
- access badges;
- capabilities;
- minimal availability.

Its future Usage tab consumes:

- quotas;
- balances;
- resets;
- costs;
- promotions;
- forecasts.

Active chat remains clean.

Detailed quota telemetry does not belong beside every message.

---

# 40. Progressive disclosure

Backend source/confidence/freshness remain preserved.

Normal primary UI can show:

```text
Updated 2m ago
```

Detail/inspector may show:

```text
Source: Command Code official CLI metadata
Confidence: Exact
Observed: 19:42
```

Do not flood every row with provenance metadata.

---

# 41. Accessibility

Visual excellence includes accessibility.

Requirements:

- full keyboard navigation;
- meaningful VoiceOver labels;
- correct toggle-state announcements;
- no color-only state communication;
- sufficient contrast;
- sensible macOS text scaling;
- focus order matching visual order.

---

# 42. Performance

Large providers may expose hundreds of models.

Model management must remain responsive.

Avoid:

- heavy card grids for huge catalogs;
- blocking refresh on main thread;
- synchronous Keychain/network work on main thread.

During refresh, preserve the previous usable catalog until replacement data is ready.

---

# 43. Provider failure behavior

Provider errors stay local.

Example:

```text
OpenRouter
Needs attention
Authentication failed
[ Reconnect ]
```

One bad provider must not replace the whole dashboard with an error.

Historical usage remains accessible.

---

# 44. Disconnect behavior

Default disconnect:

- stops collection;
- removes active credential/config;
- preserves historical usage;
- preserves visibility preferences where reasonable;
- marks routes unavailable/disconnected.

Deleting history must be a separate explicit destructive action.

---

# 45. Model disappearance

If a route disappears from provider discovery:

- keep historical identity;
- mark unavailable;
- retain history;
- remove from normal active picker;
- preserve visibility preference for possible reappearance.

---

# 46. Promotion lifecycle

A route may transition:

```text
PAYG → PROMO → PAYG
FREE → unavailable
TRIAL → PAYG
```

Do not recreate `ModelIdentity` for these transitions.

Offer observations are temporal; visibility is independent.

---

# 47. Testing strategy

Tests are necessary but are not visual acceptance.

## Service/domain

Cover:

- provider directory;
- presentation labels;
- route projection;
- access offers;
- quota summaries;
- visibility resolution;
- connection DTO secrecy;
- supported-but-unconnected providers;
- route disappearance/reappearance;
- promotion lifecycle.

## API

Verify:

- safe DTOs;
- no credential leakage;
- read vs mutation authorization;
- visibility updates;
- connection transitions.

## Swift

Cover:

- decoding;
- view models;
- empty-state logic;
- badge formatting;
- quota/reset formatting;
- visibility updates;
- grouping.

---

# 48. Mandatory visual verification loop

**Non-negotiable: do not stop after the first functional UI.**

For every major screen:

1. launch the real native macOS app;
2. populate it with public-safe representative fixtures and/or safe local data;
3. capture a screenshot;
4. compare it against the supplied Hermes references for density, spacing, hierarchy, panel proportions, search, grouping, toggles, states and visual calm;
5. identify visible weaknesses;
6. iterate;
7. repeat until genuinely polished.

Passing tests is not visual acceptance.

---

# 49. Visual acceptance bar

The redesign fails review if any of these remain true:

- it looks like a debug/admin tool;
- raw IDs are visible;
- settings expose backend JSON concepts;
- supported providers disappear until configured;
- model lists are ungrouped or difficult to curate;
- empty sections dominate;
- spacing/alignment looks accidental;
- hierarchy is weaker than Hermes;
- the menu bar is a text dump;
- free/promotional access is not discoverable;
- API connection still requires manual file editing;
- CMMChat cannot consume the same visibility catalog;
- provider errors visually break unrelated providers.

---

# 50. Hermes reference parity checklist

Before completion, explicitly verify parity or improvement for each reference pattern.

## Compact picker

Must have:

- search;
- provider/product grouping;
- current selection;
- curated models;
- `Edit models...`.

## Models editor

Must have:

- search;
- group toggles;
- model toggles;
- mixed-state groups;
- `Add provider...`.

## Accounts

Must show:

- connected;
- available;
- semantic connect flow;
- concise descriptions.

## API Keys

Must show:

- supported providers;
- connected state;
- safe key hint;
- simple add/reconnect.

## Custom Endpoints

Must support:

- endpoint form;
- Test;
- Save;
- discovery;
- default model;
- safe key handling.

CMM then adds offer/quota/promo intelligence.

---

# 51. Implementation order

Recommended sequence:

```text
1. Presentation metadata + ProviderDirectory
2. PresentationCatalogService
3. VisibilityStore (global)
4. Safe catalog API
5. ConnectionManagementService + privileged mutation API
6. Provider connection UI
7. Models editor
8. Overview / Usage / Providers redesign
9. Free & Promo
10. Menu bar redesign
11. Shared catalog contract for CMMChat
12. Screenshot-based polish loop
```

Do not resume Claude/other-provider dogfood merely to avoid finishing the product layer.

Command Code is sufficient as the first real connected fixture.

---

# 52. Commit strategy

Prefer coherent capability commits, for example:

```text
feat(usage): add presentation catalog
feat(usage): add global model visibility
feat(usage): add secure connection management
feat(usage): expose provider catalog API
feat(usage-macos): redesign provider connections
feat(usage-macos): add model catalog editor
feat(usage-macos): redesign usage dashboard
feat(usage-macos): add free and promo discovery
feat(usage-macos): redesign menu bar
```

Never commit personal config, credentials or real snapshots.

---

# 53. Definition of done

The redesign is complete only when all are true:

1. Supported providers appear even when disconnected.
2. Accounts/subscriptions and APIs can be connected from the app.
3. Custom OpenAI-compatible endpoints can be managed from the app.
4. Normal UI exposes no credential refs or canonical implementation IDs.
5. Friendly provider/product/model names exist.
6. Model editor reaches Hermes-level search/group/toggle usability.
7. Visibility persists globally.
8. Visible route catalog is reusable by CMMChat.
9. Routes can express Free / Promo / Included / Trial / PAYG.
10. Free/promotional routes show real limits/resets when known.
11. Missing limits remain explicitly unknown.
12. Overview is useful with connected and disconnected providers.
13. Quota detail preserves simultaneous windows **and provider-native units** such as credits, tokens, requests, percentages, currency and provider-defined units.
14. Hiding one provider route never hides sibling routes of the same `ModelIdentity`.
15. Hidden routes continue to participate in real quota/accounting views.
16. Shared pools are shown once with affected routes; per-model consumption is never fabricated.
17. API providers are first-class.
18. Free & Promo is discoverable.
19. Menu bar is polished and useful.
20. Empty states are intentional and actionable.
21. Provider failures remain isolated.
22. Swift/backend verification is green.
23. Major screens have been screenshot-reviewed and iterated.
24. The final visual result is at least comparable in coherence to Hermes and materially richer in information design.

---

# 53.1 Revision-v2 critical acceptance examples

These examples are normative.

## Route visibility

```text
Claude Sonnet
Anthropic direct                 Visible
Google AI / Antigravity          Visible
OpenRouter                       Hidden
```

Expected:

- CMMChat picker shows the first two routes.
- CMMChat picker omits the OpenRouter route.
- CMM Usage Quotas still shows real Anthropic, Google and OpenRouter quota/accounting state.
- No sibling route is implicitly hidden.

## Heterogeneous quota metrics

All of the following are equally valid and must render naturally:

```text
61% used
35 credits remaining
800K tokens remaining
42 / 100 requests remaining
$7.31 balance remaining
14 provider units remaining
```

There is no requirement that these be converted into one common unit.

## Shared pool

If one OpenRouter credit pool constrains twenty routes:

- display one shared pool;
- show which routes it affects;
- do not clone the same `$7.31` balance twenty times as independent model quota;
- do not invent route-specific spend unless attributable evidence exists.

---

# 54. Final product statement

The target is:

> **Hermes-quality provider/model management + CMM quota intelligence + a richer visual understanding of subscriptions, APIs, free access and promotions.**

A user opening CMM Usage should immediately understand:

- which subscriptions they have;
- which APIs are connected;
- what else can be connected;
- which models are available;
- which routes are Free, Promo, Included, Trial or PAYG;
- what limits remain;
- when limits reset;
- what is constraining usage;
- which models will appear in CMMChat.

The application must look deliberate, native and finished.

**Do not stop at “functional”.**
**Do not stop at “tests pass”.**
**Do not stop at “similar enough”.**

Iterate until the visual and interaction result is something we can place side-by-side with the supplied Hermes references and say:

> **CMM Usage is at least as coherent, and more useful.**
