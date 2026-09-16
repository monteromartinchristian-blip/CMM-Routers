# CMM Usage — Router Authority Migration Design

Date: 2026-09-16
Status: Approved design, pre-implementation specification
Branch baseline: `feature/cmm-usage` at `baf108b6f0dad0096afd97364b9a610b00121cc2`

## 1. Purpose

This migration removes the remaining operational-authority duplication between CMM Usage and the shared CMM Routers core.

The shared Router core is the canonical authority for provider identity, accounts, products/subscriptions, provider connections, secure credential references, model identity, access routes, route capabilities, route availability/routability, and route visibility.

CMM Usage remains the canonical observability and quota-intelligence subsystem. It owns usage and cost events, quota buckets and bindings, quota snapshots, balances, resets, subscription periods, historical observations, forecasts, alerts, free/promotional observations, provenance, confidence, and freshness.

The migration must preserve the current Usage product experience while changing the source of truth underneath it.

The governing invariant is:

```text
Visibility != connection != collection != accounting
```

Hiding a route must not disconnect it, stop Usage collection, remove accounting history, or hide sibling routes. Disconnecting execution must not erase prior Usage observations. Disabling a Usage collector must not make a Router execution route disappear.

## 2. Current state

The reconciled tree already contains the canonical Router authority surface:

- `src/catalog/provider-directory.ts`
- `src/catalog/provider-connections.ts`
- `src/catalog/model-identities.ts`
- `src/catalog/route-catalog.ts`
- `src/catalog/route-visibility-policy.ts`
- `src/catalog/catalog-reconciler.ts`
- `src/catalog/runtime-bridge.ts`
- `src/catalog/credential-bindings.ts`
- `src/catalog/projection.ts`
- `src/http/catalog.ts`

The safe Router projection is exposed through `GET /v1/cmm/catalog`. That projection is rebuilt from current Router state and contains providers, accounts, products, connections, model identities, and routes without exposing secret material.

CMM Usage still contains a historical parallel authority path:

- `src/usage/presentation/provider-directory.ts`
- `src/usage/presentation/visibility-store.ts`
- `src/usage/service/connection-management-service.ts`
- `src/usage/runtime/managed-config-store.ts`
- connection and visibility mutation endpoints under `/v1/cmm/usage/**`
- route/provider construction inside `src/usage/runtime/integration-catalog.ts`
- `PresentationCatalogService` deriving operational route truth from the Usage store.

These components currently mix valid Usage responsibilities with Router-owned operational state. They must be separated rather than deleted indiscriminately.

## 3. Ownership model

### 3.1 Router-owned state

The Router owns:

- provider definitions;
- provider/account/product/subscription identity;
- provider connections and connection lifecycle;
- endpoint definitions;
- custom endpoints;
- execution profiles;
- execution credential bindings;
- observability credential bindings;
- secure credential references;
- model identities and exact provider-model bindings;
- access routes;
- route capabilities;
- routability and execution availability;
- route visibility per consumer surface;
- provider administrative model discovery;
- CMMChat and CMM Code route resolution.

Secrets remain physically in Keychain or another secure store. Router state may contain secure references but never raw secret values in tracked configuration or Usage SQLite.

### 3.2 Usage-owned state

CMM Usage owns:

- Usage adapters and collectors;
- provider-native usage events;
- cost events;
- quota groups and buckets;
- route-to-quota bindings;
- quota snapshots;
- balances and credits;
- resets and rolling/fixed windows;
- subscription periods;
- historical observations;
- source provenance;
- confidence and exactness;
- freshness/staleness;
- forecasts;
- alerts;
- free, promotional, included, trial and PAYG observations;
- presentation enrichment derived from the above.

Usage may retain historical references to Router IDs so historical accounting survives route removal or disconnection.

### 3.3 Explicit non-ownership

CMM Usage must not independently create or mutate canonical:

- provider IDs;
- account IDs;
- product IDs;
- model identity IDs;
- access route IDs;
- route visibility;
- execution availability;
- execution credentials;
- provider connection lifecycle.

Synthetic demo fixtures are allowed only in explicit Demo/Preview mode and must never become Router state.

## 4. Canonical operational configuration

Router-owned operational configuration remains under the shared Router configuration domain, primarily `config/shared.json` and its validated schema.

The shared configuration will be extended only as necessary to represent administrative state that already belongs to Routers:

- provider connection definitions;
- account/product association needed by those connections;
- execution and observability credential binding references;
- custom endpoint definitions;
- route visibility rules.

The persisted representation must contain secure references only. Raw API keys, session tokens, cookies, OAuth blobs, or similar secrets must never be serialized into shared config.

`config/usage.json` remains only for Usage-specific collector behavior and observability settings that are not operational Router authority. During migration, legacy fields may be read for compatibility, but new writes must not create new Router-owned state there.

## 5. Router administration layer

The Router needs a dedicated administrative service before the old Usage mutation path can be removed.

The new service is conceptually `RouterAdministrationService`. Exact file naming may follow existing project conventions during implementation.

It must provide operations for:

- connect provider/account using a supported connection method;
- disconnect a provider connection;
- enable or disable a provider connection;
- add or remove a custom endpoint;
- validate/test a connection;
- refresh administrative model discovery;
- create/update the required secure credential binding;
- update route visibility for supported Router surfaces.

The service writes Router-owned state only. It does not write Usage SQLite and does not synthesize Usage events or quotas.

Connection creation must fail closed if:

- provider ID is unknown;
- connection kind is unsupported;
- required credential material cannot be stored securely;
- a credential binding cannot be resolved;
- the resulting connection cannot be represented by the canonical Router schema.

Visibility updates must operate on `AccessRoute`/Router visibility policy semantics, never on `ModelIdentity`. A visibility change for one route must not implicitly affect sibling routes unless an explicitly selected group operation expands to those route IDs.

## 6. Administrative HTTP surface

The existing `GET /v1/cmm/catalog` remains the canonical safe read projection.

A Router-owned administrative HTTP surface will be added for mutations. The exact route names may follow the repository's existing HTTP conventions, but the semantics are fixed:

- mutations are Router endpoints, not Usage-owned endpoints;
- they require privileged management authentication;
- read-only Usage credentials cannot mutate Router state;
- responses are safe projections and never expose raw secrets or secure refs unnecessarily;
- mutation failures are fail-closed and do not silently fall back to Usage-owned state.

The old endpoints under `/v1/cmm/usage/connections/**` and `/v1/cmm/usage/catalog/visibility` become compatibility delegates during migration and are removed only after all native clients use the Router administration API.

There must never be two independently writable authorities.

## 7. Usage presentation becomes Router truth plus Usage intelligence

`PresentationCatalogService` remains as a product/presentation layer, but its input model changes.

Instead of treating Usage SQLite as the source of operational providers/routes/visibility, it consumes the safe Router catalog projection and enriches it with Usage-owned information.

Conceptually:

```text
Router catalog projection
        +
Usage quota/history/intelligence
        =
CMM Usage presentation catalog
```

For every Router route, Usage may attach:

- current quota summaries;
- shared-pool relationships;
- balance information;
- offer classification;
- freshness;
- historical consumption;
- forecast/exhaustion information;
- alerts;
- cost information.

Router fields remain authoritative for:

- route identity;
- provider/account/product identity;
- model identity;
- connection state;
- routability;
- capabilities;
- visibility.

If Usage has historical observations for a route no longer present in the current Router catalog, those observations remain queryable in historical views but do not recreate an operational route.

## 8. Visibility migration

The current Usage `VisibilityStore` and `visibility_preferences` table are legacy operational authority.

Migration rules:

1. Router visibility is immediately authoritative for all current product surfaces.
2. Existing Usage visibility rows are not deleted during the first migration step.
3. A one-time compatibility/migration reader may translate unambiguous legacy route-scoped preferences into Router visibility rules.
4. Migration must never broaden visibility. Ambiguous or unmappable rows fail closed and are reported rather than guessed.
5. After migration, Usage reads effective visibility from Router projection only.
6. New visibility writes go only through Router administration.
7. The legacy table can be deprecated and later removed only after:
   - no production code reads it for effective visibility;
   - no production API writes it;
   - migration/compatibility coverage passes;
   - historical Usage data remains unaffected.

Workspace-scoped legacy visibility is not promoted into Router state unless a corresponding Router surface/workspace concept is explicitly designed later. No implicit workspace semantics are invented in this migration.

## 9. Connection migration

The current Usage `ConnectionManagementService` combines legitimate UI workflow with incorrect ownership.

Its user-facing capabilities are preserved while ownership moves to Routers.

The Usage/macOS UI may continue to expose:

- Accounts;
- API Keys;
- Custom Endpoints;
- Connect;
- Disconnect;
- Enable/Disable;
- Test Connection;
- model discovery/refresh.

But these actions delegate to Router administration.

Usage collectors attach to Router-owned provider/account/product/connection identities. Collector enablement is separate from Router connection enablement.

A provider may therefore be:

- executable but not actively collected by Usage;
- collected for observability but not executable;
- both;
- neither.

These states must remain explicit and must not be collapsed into one boolean.

## 10. Credential model

Credential ownership follows the existing split between execution and observability bindings.

A single secure secret reference may be used by both purposes only when there are two explicit bindings authorizing each purpose.

Removing an observability binding must not disable execution.

Removing an execution binding must fail route execution closed while Usage observability may continue if its binding remains valid.

Usage adapters must receive credentials through an observability-authorized resolution path. Usage must not infer permission to observe merely because an execution credential exists.

No raw credential content is stored in Usage SQLite, logs, catalog projections, diagnostics, or presentation models.

## 11. Custom endpoints

Custom OpenAI-compatible endpoints are operational Router entities.

The Router creates and owns:

- provider identity;
- account/product identity where applicable;
- connection;
- endpoint reference;
- model discovery;
- access routes;
- route visibility;
- execution credential binding.

Usage may add observability support for that endpoint when usage/billing/quota endpoints exist. Those collector-specific endpoints or parsing settings belong to Usage, but they reference the canonical Router identity.

`useInCmmChat` is not a Usage setting after migration. CMMChat exposure is represented only through Router route visibility.

Usage must stop fabricating `provider:custom:*`, `account:custom:*`, `product:custom:*`, or `route:custom:*` as canonical operational identities.

## 12. Demo and preview behavior

The existing product invariant remains:

```text
NORMAL
→ exclusively real state
→ no invented values

DEMO/PREVIEW
→ synthetic fixtures
→ visibly “Demo Data”
→ development/tests/screenshots only
```

Demo fixtures may still seed an isolated Usage presentation environment for tests and screenshots.

They must not:

- mutate Router operational state;
- share persistent production storage;
- become visible through normal `/v1/cmm/catalog`;
- create real credential bindings;
- be treated as connected real providers.

## 13. Data flow after migration

### 13.1 Normal read

```text
Router core
  → safe Router catalog projection
  → Usage presentation enrichment
  → CMM Usage API
  → native macOS app / future CMMChat Usage tab
```

### 13.2 Connection mutation

```text
CMM Usage UI
  → Router administration API
  → secure credential writer + Router config
  → ProviderConnectionService / CatalogReconciler
  → updated Router catalog
  → Usage observes refreshed Router projection
```

### 13.3 Usage collection

```text
Router-owned provider/account/product identity
  + explicit observability credential binding
  → Usage adapter
  → usage/cost/quota observations
  → Usage SQLite
  → presentation enrichment
```

### 13.4 Visibility mutation

```text
CMM Usage UI / CMMChat settings
  → Router administration API
  → Router visibility policy/config
  → RouteCatalog projection
  → all consumers observe same visibility truth
```

## 14. Failure semantics

The migration must prefer explicit unknown/unavailable states over fabricated fallback state.

If Router catalog read fails:

- Usage may continue to show historical Usage data;
- it must not present stale Usage routes as currently executable;
- operational connection/visibility controls fail closed;
- the UI distinguishes historical/observability data from current Router state.

If Usage enrichment fails:

- Router catalog truth remains intact;
- route execution and visibility are unaffected;
- Usage-specific quota/cost fields may be unavailable/stale with provenance preserved.

If secure credential resolution fails:

- the affected purpose fails independently;
- execution failure does not automatically erase observability history;
- observability failure does not automatically disable execution.

## 15. Compatibility strategy

Migration is staged so the app never loses a capability merely because authority moved.

Order:

1. add Router administrative mutation capabilities;
2. expose stable safe Router reads needed by Usage;
3. make Usage presentation consume Router catalog truth;
4. redirect Usage connection mutations to Router administration;
5. redirect visibility mutations to Router administration;
6. attach Usage collectors through observability bindings to Router identities;
7. remove operational authority from `ConnectionManagementService`;
8. remove effective-visibility authority from `VisibilityStore`;
9. stop creating operational IDs in `UsageIntegrationCatalog`;
10. deprecate/remove legacy Usage config/schema only after no production dependency remains.

Compatibility endpoints may temporarily exist, but they must delegate to Router authority. They may not keep a second writable implementation.

## 16. Testing strategy

Implementation follows TDD.

Required coverage includes:

### Router administration

- connect/disconnect/enable/disable;
- custom endpoint lifecycle;
- exact provider/connection identity;
- secure-reference-only persistence;
- read-only credential rejection;
- management authentication;
- no secret leakage;
- fail-closed unsupported connection kinds;
- route visibility mutation scoped to exact route.

### Boundary invariants

- observability-only credential cannot authorize execution;
- execution-only state does not imply Usage collection;
- hiding a route does not change routability;
- hiding one route does not hide sibling routes;
- disabling Usage collection does not disconnect Router execution;
- disconnecting execution does not delete Usage history;
- Usage cannot create canonical Router identities;
- projection mutation cannot mutate Router state.

### Usage presentation

- Router identity/visibility/availability wins over legacy Usage state;
- Usage quota/balance/history enrichment remains attached correctly;
- removed Router route remains historical only;
- unknown values remain unknown;
- provenance/freshness preserved;
- no universal percentage is invented.

### Migration

- legacy visibility rows migrate only when unambiguous;
- ambiguous rows fail closed;
- no visibility broadening;
- legacy connection config does not create duplicate Router connections;
- custom endpoint IDs are Router-generated/canonical;
- demo data remains isolated.

### Regression gates

At each implementation milestone:

- targeted tests;
- `npm run typecheck`;
- `npm run build`;
- relevant Usage and catalog integration suites.

Before closing the migration:

- complete serial Node suite;
- publication verification;
- Swift tests;
- Swift contract tests;
- Swift release build;
- tracked worktree clean;
- preserved local `.superpowers` work untouched unless explicitly in scope.

## 17. Files expected to change

The exact implementation plan will refine this list, but the design expects changes primarily in:

Router authority:

- `src/catalog/**`
- `src/config/schema.ts`
- `src/http/catalog.ts`
- `src/http/server.ts`
- `src/index.ts`

Usage delegation/presentation:

- `src/usage/presentation/presentation-catalog-service.ts`
- `src/usage/runtime/production-runtime.ts`
- `src/usage/runtime/integration-catalog.ts`
- `src/usage/service/connection-management-service.ts`
- `src/usage/api/connection-routes.ts`
- `src/usage/api/catalog-routes.ts`

Legacy components eventually deprecated:

- `src/usage/presentation/visibility-store.ts`
- `src/usage/runtime/managed-config-store.ts`
- `src/usage/storage/schema/003_catalog_visibility.sql`
- associated tests and types.

These legacy files must not be removed before their production responsibilities have been migrated and verified.

## 18. Out of scope

This migration does not:

- redesign the CMM Usage visual UI;
- add automatic model routing;
- merge CMM Usage into CMMChat yet;
- change quota forecasting algorithms;
- change provider billing semantics;
- add workspace-specific visibility;
- delete historical Usage records;
- publish or push a public release;
- alter CMM Code Router tool semantics.

## 19. Completion criteria

The architecture migration is complete only when all of the following are true:

1. Router is the sole writable authority for operational provider connections and route visibility.
2. Usage presentation reads current operational identity and route truth from Router.
3. Usage enriches Router routes with quota/cost/history intelligence without overriding Router fields.
4. Usage collectors use explicit observability authorization.
5. No production Usage code fabricates canonical operational route/provider/account/product identity.
6. Legacy Usage visibility is no longer an effective product authority.
7. Compatibility mutation endpoints, if retained, delegate exclusively to Router.
8. Historical Usage data survives route removal/disconnection.
9. Demo data cannot contaminate normal Router state.
10. Full Node, publication, Swift, and boundary regression gates pass.

Only after these criteria are verified should legacy authority code/schema be removed or declared closed.
