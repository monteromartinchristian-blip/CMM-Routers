# CMM Routers — Shared Core, Provider Connections and Route Catalog

**Date:** 2026-09-15
**Status:** Approved; implementation authorized for Subagent-Driven Development
**Scope:** CMM Routers shared core used by CMMChat Router, CMM Code Router and CMM Usage

## 1. Purpose

CMM Routers needs one canonical shared core that describes the real providers, accounts, products, credentials, models and executable access routes available to the system.

The core must answer two different questions without mixing them:

1. Can CMM Routers execute this model through this provider connection?
2. Can CMM Usage observe quota, balance, limits or billing for this provider/account/product?

The architectural boundary is:

> **CMM Routers owns connectivity and execution. CMM Usage owns observability.**

CMM Usage may store or reuse API credentials for quota/balance/usage collection, but adding a credential to CMM Usage must never make that credential executable by CMMChat Router or CMM Code Router.

## 2. Goals

The first implementation slice must provide:

- a canonical `ProviderDirectory`;
- a canonical `ProviderConnectionService`;
- account and product identities;
- secure credential references and explicit authorization bindings;
- real model discovery;
- stable `ModelIdentity` objects;
- stable executable `AccessRoute` objects;
- per-consumer route visibility;
- route resolution by `routeId`;
- a read-only projection that CMM Usage can consume;
- no duplicated provider/model/route universe inside CMM Usage.

Target flow:

```text
real provider
    ↓
real connection
    ↓
real model discovery
    ↓
canonical ModelIdentity
    ↓
canonical AccessRoute
    ↓
routeId
    ├── CMMChat Router → CHAT_ONLY execution
    ├── CMM Code Router → CHAT_AND_TOOLS execution
    └── CMM Usage → read-only observation metadata
```

## 3. Non-goals

This design does not require:

- completing the full CMMChat application;
- completing the full CMM Usage frontend;
- adding advanced automatic routing or ranking;
- silent provider fallback;
- automatic promotion of Usage credentials into execution credentials;
- one universal billing/quota schema inside CMM Routers;
- replacing CMM Usage forecasting, alerts or history;
- live canaries for every provider as part of the first shared-core slice.

## 4. Frozen responsibility boundary

### CMM Routers / shared core owns

```text
providers
accounts
subscriptions / API products
execution-capable connections
secure credential resolution for execution
model discovery
ModelIdentity
AccessRoute
route capabilities
route routability
route visibility
route execution metadata
```

### CMMChat Router owns

```text
CHAT_ONLY execution
streaming
cancellation
provider protocol translation
routeId resolution at request time
telemetry emission
consumer capability enforcement
```

### CMM Code Router owns

```text
CHAT_AND_TOOLS execution
coding / agent / tool execution
tool-loop semantics
consumer capability enforcement
```

### CMM Usage owns

```text
quota windows
balances
resets
token counts
request counts
percentages
credits
costs
free/promotional access state
usage history
forecasts
alerts
provider/account usage health
```

CMM Usage must not define its own canonical providers, models or routes. It consumes read-only identities from the shared Routers core and enriches them with observability state.

## 5. Core invariants

```text
connected  != routable
routable   != visible
visible    != monitored
monitored  != billable
```

And:

```text
observability authorization != execution authorization
```

Consequences:

- a provider may be connected but temporarily non-routable;
- a route may be routable but hidden from CMMChat;
- a hidden route may still be observed by CMM Usage;
- a provider may expose usage data without being executable;
- a provider may be executable while exposing no usable quota API;
- a Usage credential never becomes an execution credential implicitly.

## 6. Domain model

### ProviderDefinition

Represents a provider family known by CMM Routers.

```ts
interface ProviderDefinition {
  providerId: string;
  displayName: string;
  adapterKind: string;
  supportedConnectionKinds: ConnectionKind[];
  discoveryCapabilities: DiscoveryCapability[];
}
```

It contains no account-specific secrets and no live connection state.

### ProviderDirectory

Canonical registry of provider definitions and adapter/discovery factories.

Responsibilities:

- register provider definitions;
- resolve provider metadata;
- expose supported connection kinds;
- instantiate the correct connection/discovery/execution adapter;
- prevent duplicate provider IDs;
- remain independent of CMM Usage.

It does not own credentials, quota state or consumer visibility.

### Account

```ts
interface Account {
  accountId: string;
  providerId: string;
  label: string;
  externalAccountRef?: string;
}
```

An account may have multiple products and multiple connections.

### ProviderProduct

```ts
type ProductKind =
  | "subscription"
  | "api"
  | "free_pool"
  | "promo_pool"
  | "enterprise"
  | "local";

interface ProviderProduct {
  productId: string;
  accountId: string;
  providerId: string;
  kind: ProductKind;
  label: string;
}
```

Product identity is descriptive. Execution still requires an explicit `ProviderConnection`.

### SecretMaterialRef

No raw secret value belongs in the domain model.

```ts
interface SecretMaterialRef {
  secretRef: string;
  storageKind: "keychain" | "native_secure_store";
}
```

The same physical secret may be referenced by multiple logical bindings, but only by explicit user action.

## 7. Credential authorization model

The physical secret and its allowed purpose are separate concepts.

### ExecutionCredentialBinding

```ts
interface ExecutionCredentialBinding {
  bindingId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  secretRef: string;
  purpose: "execution";
  enabled: boolean;
}
```

Only an enabled execution binding may participate in an executable `ProviderConnection`.

### ObservabilityCredentialBinding

```ts
interface ObservabilityCredentialBinding {
  bindingId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  secretRef: string;
  purpose: "observability";
  enabled: boolean;
}
```

This binding may be created by CMM Usage for balance/quota/usage collection.

It does not make any route executable.

### Explicit reuse of one physical secret

The system may reuse one `SecretMaterialRef` for both purposes:

```text
secretRef: keychain://openrouter/main

ExecutionCredentialBinding
    └── purpose = execution

ObservabilityCredentialBinding
    └── purpose = observability
```

But the two bindings are independent.

Adding an observability binding must never create the execution binding automatically.

A future UI may offer:

```text
Reuse this credential for execution
```

That action must be explicit and must create a separate `ExecutionCredentialBinding`.

## 8. ProviderConnection

```ts
type ConnectionStatus =
  | "configured"
  | "validating"
  | "ready"
  | "auth_required"
  | "unavailable"
  | "disabled"
  | "error";

interface ProviderConnection {
  connectionId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  connectionKind: ConnectionKind;
  executionCredentialBindingId?: string;
  profileRef?: string;
  endpointRef?: string;
  status: ConnectionStatus;
}
```

A `ProviderConnection` may exist without being routable.

## 9. ProviderConnectionService

Canonical lifecycle authority for connections.

Responsibilities:

- create/update/disable connections;
- validate required configuration;
- resolve execution credential bindings through `SecureCredentialResolver`;
- perform non-inference health/auth checks where supported;
- expose connection status;
- invoke provider-specific model discovery;
- never import quota/balance semantics from CMM Usage;
- never infer an execution credential from an observability credential.

The service must fail closed when execution authorization is missing or ambiguous.

## 10. SecureCredentialResolver

```ts
interface SecureCredentialResolver {
  resolve(secretRef: string): Promise<ResolvedSecret>;
}
```

Rules:

- no domain object contains raw values;
- no secret value is returned in diagnostics;
- resolver results have the minimum lifetime required for the operation;
- logging identifies references, never secret material;
- observability and execution bindings may reference the same secret only through explicit independent bindings.

## 11. Model discovery

Model discovery is administrative, not inferential.

Preferred methods:

```text
GET /models
provider CLI model listing
provider metadata endpoint
provider SDK administrative discovery
```

Discovery must not send a user prompt or spend inference quota merely to populate the catalog.

Each discovery result is provider-specific evidence and must be normalized before becoming a canonical model identity.

## 12. ModelIdentity

```ts
interface ModelIdentity {
  modelIdentityId: string;
  canonicalName: string;
  family?: string;
  aliases: string[];
}
```

`ModelIdentity` represents the model concept independently from the route used to reach it.

Example:

```text
ModelIdentity: Claude Sonnet

Possible access routes:
- Claude direct
- Google AI / Antigravity
- OpenRouter
```

Provider model IDs remain route/provider-specific metadata and must not force duplicate canonical model identities.

Where canonicalization is uncertain, the system preserves distinct identities rather than guessing.

## 13. AccessRoute — canonical executable unit

`AccessRoute` is the unit CMM Routers executes.

```ts
interface AccessRoute {
  routeId: string;
  modelIdentityId: string;
  connectionId: string;
  providerId: string;
  providerModelId: string;
  executionProfile: ExecutionProfile;
  capabilities: RouteCapabilities;
  billingClass: BillingClass;
  routable: boolean;
  visibility: RouteVisibility;
}
```

`routeId` must be stable across restarts and identify one exact route:

```text
model identity
+ provider
+ connection
+ provider model id
+ execution profile
```

No request should infer a provider from a model name.

## 14. Route resolution

CMMChat Router and CMM Code Router receive a `routeId`.

```json
{
  "routeId": "route_claude_sonnet_claude_pro_main",
  "messages": []
}
```

Resolution:

```text
routeId
  ↓
AccessRoute
  ↓
ProviderConnection
  ↓
ExecutionCredentialBinding
  ↓
SecureCredentialResolver
  ↓
provider adapter
  ↓
providerModelId
  ↓
execution
```

If any required link is unavailable, disabled, ambiguous or unauthorized, execution fails closed.

There is no silent PAYG fallback and no cross-provider fallback implied by model identity.

## 15. Route capabilities

Capabilities belong to the route, not merely the model family.

```ts
interface RouteCapabilities {
  chat: boolean;
  tools: boolean;
  vision?: boolean;
  reasoningEffort?: boolean;
  streaming: boolean;
}
```

The same `ModelIdentity` may have different capabilities on different routes.

CMMChat Router enforces CHAT_ONLY consumer policy even if a route is more capable.

CMM Code Router may use CHAT_AND_TOOLS only when the route truthfully advertises it.

## 16. RouteVisibility

Visibility is consumer/surface-specific and is not a single global boolean.

```ts
type RouteSurface =
  | "cmmchat_model_picker"
  | "cmmcode_model_picker"
  | "admin_console";

interface RouteVisibility {
  visibleOn: RouteSurface[];
}
```

Example:

```text
Claude Sonnet
├── Claude direct
│   visibleOn: [cmmchat_model_picker, cmmcode_model_picker]
│
├── Google AI / Antigravity
│   visibleOn: [cmmchat_model_picker]
│
└── OpenRouter
    visibleOn: []
```

Visibility is enforced at the server boundary as well as in UI projections.

A CMMChat client must not be able to manually submit a hidden CMMChat route and bypass picker policy.

Visibility does not control CMM Usage collection.

## 17. Routability

`routable` is owned by CMM Routers.

It is derived from execution truth:

```text
connection enabled
execution credential binding available
provider/auth status acceptable
provider model available
route capabilities valid
spending/fail-closed policy satisfied
adapter available
```

CMM Usage may surface quota exhaustion or billing state, but it does not become the authority that mutates route identity or execution authorization.

## 18. CMM Usage integration contract

CMM Usage consumes a read-only projection.

```ts
interface RouterCatalogProjection {
  providers: ProviderSummary[];
  accounts: AccountSummary[];
  products: ProductSummary[];
  connections: ProviderConnectionSummary[];
  models: ModelIdentitySummary[];
  routes: AccessRouteSummary[];
}
```

CMM Usage may attach:

```text
connectionId / accountId / productId / routeId
    ↓
quota
balance
reset
tokens
requests
cost
free/promotional pool
forecast
alerts
history
```

But it may not create a canonical provider, model or route merely because a fixture or usage collector knows about one.

## 19. Usage-only credentials

CMM Usage may add a credential solely for observation.

```text
OpenRouter API key
    ↓
ObservabilityCredentialBinding
    ↓
CMM Usage:
  balance
  spend
  token totals
  request totals

CMM Routers:
  no execution binding
  no ProviderConnection made routable
  no AccessRoute enabled
```

If the user later chooses to execute through that same key:

```text
explicit user action
    ↓
create ExecutionCredentialBinding
    ↓
bind/create ProviderConnection
    ↓
discover models
    ↓
create/update AccessRoute
```

No automatic promotion is allowed.

## 20. CMMChat contract

CMMChat consumes product-safe projections.

Model picker:

```text
RouteCatalog
    ↓
filter surface = cmmchat_model_picker
    ↓
group by ModelIdentity
    ↓
show visible routes
```

Execution:

```text
user selects route
    ↓
CMMChat sends routeId
    ↓
CMMChat Router resolves routeId
    ↓
CHAT_ONLY policy enforcement
    ↓
provider execution
```

CMMChat never receives raw credentials, local profile paths or provider-native secret configuration.

## 21. Example end state

```text
ModelIdentity: Claude Sonnet

route_claude_direct
├── provider: claude
├── connection: claude-pro-main
├── product: Claude Pro
├── capability: CHAT_AND_TOOLS
├── routable: true
└── visible:
    ├── CMMChat: true
    └── CMM Code: true

route_claude_antigravity
├── provider: google
├── connection: google-ai-pro-main
├── product: Google AI Pro
├── capability: CHAT_AND_TOOLS
├── routable: true
└── visible:
    ├── CMMChat: true
    └── CMM Code: true

route_claude_openrouter
├── provider: openrouter
├── connection: openrouter-main
├── product: OpenRouter API
├── capability: CHAT_ONLY
├── routable: true
└── visible:
    ├── CMMChat: false
    └── CMM Code: false
```

CMM Usage may still show real OpenRouter balance and quota for the route or its parent account/product even while the route is hidden.

## 22. Error handling and fail-closed rules

The shared core fails closed on:

- unknown `routeId`;
- disabled route;
- route hidden from the requesting consumer;
- missing connection;
- missing execution credential binding;
- missing secret material;
- invalid provider authentication;
- unavailable provider model;
- unsupported requested capability;
- ambiguous model canonicalization;
- unacknowledged PAYG/spend policy where applicable.

No error path may silently switch providers or billing classes.

## 23. Persistence and identity rules

IDs must be stable and opaque:

```text
providerId
accountId
productId
connectionId
modelIdentityId
routeId
bindingId
secretRef
```

User-facing labels may change without changing stable IDs.

A model disappearing from provider discovery becomes unavailable; it is not silently deleted from identity/history.

Routes should be updated in place when the same stable provider connection/model route is rediscovered.

## 24. Testing strategy

### Identity and directory

- duplicate provider IDs rejected;
- provider definitions contain no secrets;
- stable route identity survives restart/reload;
- uncertain canonical model mapping does not guess.

### Credential separation

- observability-only credential cannot make a route executable;
- execution-only credential does not automatically enable Usage collection;
- one physical secret can support two explicit bindings;
- deleting one binding does not implicitly delete the other.

### Route execution

- request resolves exactly one `routeId`;
- no provider inference from display name;
- no silent fallback;
- hidden route rejected for unauthorized consumer;
- CHAT_ONLY consumer cannot escalate to tools.

### Discovery

- administrative discovery uses no inference;
- missing model becomes unavailable;
- discovery failures are isolated per connection;
- provider-specific model IDs are preserved.

### CMM Usage boundary

- Usage cannot create canonical providers/models/routes;
- Usage fixtures never leak into real-state projection;
- Usage can observe a hidden route;
- Usage observability credential never creates an execution binding.

### Security

- no tracked secret values;
- no raw secrets in logs;
- secret resolver used at execution boundary only;
- consumer visibility enforced server-side.

## 25. First implementation slice

Build only:

```text
ProviderDirectory
Account / ProviderProduct identities
SecretMaterialRef
ExecutionCredentialBinding
ObservabilityCredentialBinding contract
ProviderConnection
ProviderConnectionService
SecureCredentialResolver interface
ModelIdentity
AccessRoute
RouteCatalog
RouteVisibility
read-only RouterCatalogProjection
routeId resolution
```

Then adapt the already implemented real provider bridges to register/discover through this shared core.

Do not redesign CMM Usage UI in this slice.

## 26. Migration from current CMM Routers

The existing provider manifests/adapters remain valuable.

Migration preserves:

- current provider IDs where already canonical;
- existing provider-specific adapters;
- generic OpenAI-compatible adapter;
- current fail-closed PAYG rules;
- current CHAT_ONLY / CHAT_AND_TOOLS truthfulness;
- current deterministic provider tests.

The migration introduces the shared identity/connection/route layer above those adapters rather than replacing working transport code.

## 27. Acceptance criteria

The architecture slice is complete when:

```text
1. A real provider connection can be represented without raw secrets.
2. A real provider connection can discover real provider model IDs.
3. A discovered model can map to a stable ModelIdentity.
4. One ModelIdentity can expose multiple AccessRoutes.
5. Every executable request is addressed by routeId.
6. CMMChat can list only routes visible to CMMChat.
7. Hidden routes cannot be invoked by CMMChat through manual routeId spoofing.
8. CMM Usage can consume the same provider/account/model/route identities read-only.
9. A credential added only to CMM Usage cannot enable execution.
10. One physical secret can be deliberately reused through two independent bindings.
11. No silent PAYG or cross-provider fallback exists.
12. No new parallel provider/model universe is created inside CMM Usage.
```

## 28. Frozen decisions

```text
AccessRoute is the canonical executable unit.
routeId selects provider + connection + provider model + execution profile.
ModelIdentity is independent from provider route.
RouteVisibility is surface-specific.
Visibility != connection != collection != accounting.
Observability authorization != execution authorization.
One physical secret may be reused, but execution and observability bindings remain independent.
Adding a key in CMM Usage never enables CMMChat execution automatically.
CMM Usage consumes a read-only projection of the Routers catalog.
No silent PAYG fallback.
```
