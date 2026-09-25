# CMM Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use a task-by-task development workflow with fresh review checkpoints. The plan is intentionally outcome-driven: preserve the frozen domain contracts and acceptance criteria, but use engineering judgment for internal implementation details after inspecting the repository.

**Goal:** Implement CMM Usage inside CMM Routers as a local-first, extensible observability system for AI API/subscription usage, arbitrary quota graphs, costs, reset windows, forecasting, alerts, dynamic provider integrations, and a native macOS client.

**Architecture:** CMM Usage is a separate subsystem inside CMM Routers. Its core models providers/accounts/products/subscription periods, conceptual models, concrete access routes, and many-to-many quota buckets/bindings. It ingests both per-request events and provider snapshots, reconciles provenance/confidence, persists locally through a storage abstraction, exposes a read-oriented local API, and later powers a native macOS menu-bar/full-window client. Provider-specific collection remains behind capability-based adapters.

**Tech Stack:** Existing CMM Routers Node.js/TypeScript stack; SQLite behind `UsageStore`; Node 26+ baseline; existing repository test runner and HTTP stack; macOS Swift/SwiftUI + Keychain for the native client where appropriate.

**Spec:** `docs/superpowers/specs/2026-09-12-cmm-usage-design.md`

## Global Constraints

- The frozen design specification is authoritative for product semantics.
- CMM Usage lives inside `CMM-Routers`; it is not a parallel standalone repo in v1.
- ModelIdentity and AccessRoute are distinct.
- Quotas are a graph of QuotaBuckets connected to AccessRoutes through QuotaBindings.
- Event ingestion and snapshot ingestion coexist.
- Metrics and windows are extensible and provider-neutral.
- Every displayed/selected value preserves provenance, confidence, freshness, and native units.
- No prompt or completion content enters CMM Usage persistence.
- Secrets remain in Keychain or existing secure provider storage, not SQLite.
- Collection must not trigger paid/quota-consuming inference merely to discover usage.
- Cancelling/disabling a provider or subscription never destroys historical usage.
- Generic OpenAI-Compatible and Manual integrations are first-class fallback paths.
- v1 observes, measures, reconciles, forecasts, and alerts; it does not automatically reroute inference.
- The implementation must be public-ready by construction: no personal paths, credentials, account IDs, private usage fixtures, or user-specific defaults in committed code/docs/tests.
- Existing CMM Routers behavior and tests must remain green.

---

## Repository reconnaissance before Task 1

Before editing, the executor must inspect:

```bash
git status --short
git branch --show-current
git log -5 --oneline --decorate
find src tests docs -maxdepth 3 -type f | sort | sed -n '1,240p'
cat package.json
```

Read the frozen spec fully.

The paths below are the canonical target layout. If the existing repository has an established equivalent integration path (for example, HTTP route registration or application bootstrap), use that existing path rather than creating a competing framework. Do not change domain names/interfaces merely to match incidental file placement.

Create a feature branch from the approved base:

```bash
git switch -c feature/cmm-usage
```

Do not implement on `main`.

---

## Target file map

```text
src/usage/
  domain/
    types.ts
    quota-resolution.ts
    validation.ts
  storage/
    usage-store.ts
    sqlite-usage-store.ts
    migrations.ts
    schema/
      001_initial.sql
  registry/
    usage-registry.ts
  adapters/
    contract.ts
    adapter-manager.ts
    manual/
      adapter.ts
    openai-compatible/
      adapter.ts
    command-code/
      adapter.ts
    qoder/
      adapter.ts
    claude/
      adapter.ts
    google-ai-pro/
      adapter.ts
    openai/
      adapter.ts
    deepseek/
      adapter.ts
  ingestion/
    event-ingestor.ts
    snapshot-ingestor.ts
  reconciliation/
    reconciler.ts
  forecasting/
    quota-forecast.ts
  alerts/
    alert-engine.ts
  scheduler/
    collection-scheduler.ts
  service/
    usage-service.ts
    usage-query-service.ts
  api/
    usage-routes.ts
    usage-auth.ts
  index.ts

tests/usage/
  domain/
  storage/
  registry/
  reconciliation/
  forecasting/
  alerts/
  adapters/
  api/
  integration/
  fixtures/

apps/cmm-usage-macos/
  Package.swift or Xcode project structure selected after repo inspection
  Sources/
  Tests/
```

Existing repo integration points may be modified where necessary for:
- service bootstrap/shutdown;
- HTTP route registration;
- inference telemetry emission;
- configuration;
- existing auth scopes/redaction;
- package/build/test scripts.

---

### Task 1: Canonical domain types and quota resolution

**Files:**
- Create: `src/usage/domain/types.ts`
- Create: `src/usage/domain/validation.ts`
- Create: `src/usage/domain/quota-resolution.ts`
- Create: `tests/usage/domain/quota-resolution.test.ts`
- Create: `tests/usage/fixtures/quota-scenarios.ts`

**Interfaces:**
- Produces the canonical TypeScript representations for Provider, Account, Product, SubscriptionPeriod, ModelIdentity, AccessRoute, QuotaGroup, QuotaBucket, QuotaBinding, ConsumptionRule, UsageEvent, CostEvent, QuotaSnapshot, provenance/confidence, route health, metrics, and window policies.
- Produces `resolveRouteHealth(...)` for later query/API/UI layers.

- [ ] **Step 1: Write canonical fixtures and failing domain tests**

Create fixtures representing at minimum:

```ts
export const canonicalQuotaScenarios = {
  modelSpecificApi: {},
  sharedFreePool: {},
  commandCodeStyle: {},
  googleAiProStyle: {},
  claudeStyle: {},
  openAiStyle: {},
  balanceOnly: {},
  percentageOnly: {},
} as const;
```

The tests must assert behavior, not internal representation details:

```ts
it("marks a route exhausted when any bound hard bucket is exhausted", () => {
  const state = resolveRouteHealth(fixture);
  expect(state.status).toBe("exhausted");
  expect(state.primaryConstraint?.bucketId).toBe("model-specific");
});

it("does not average unrelated quota percentages", () => {
  const state = resolveRouteHealth(mixedMetricFixture);
  expect(state).not.toHaveProperty("aggregateAvailabilityPercent");
});

it("keeps the same model identity independent across access routes", () => {
  expect(anthropicRoute.modelIdentityId).toBe(googleRoute.modelIdentityId);
  expect(anthropicRoute.id).not.toBe(googleRoute.id);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Use the repository's existing test runner. If it is Vitest, for example:

```bash
npm test -- tests/usage/domain/quota-resolution.test.ts
```

Expected: FAIL because domain types/resolver do not yet exist.

- [ ] **Step 3: Implement the minimal canonical domain**

Use discriminated unions for open metric/window semantics where useful. Keep provider-defined extension fields explicit rather than scattering arbitrary provider keys through core logic.

Required high-level signatures:

```ts
export type QuotaStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "exhausted"
  | "unavailable"
  | "unknown";

export type Confidence =
  | "exact"
  | "measured"
  | "calculated"
  | "estimated"
  | "unknown";

export interface RouteHealth {
  accessRouteId: string;
  status: QuotaStatus;
  constraints: ResolvedQuotaConstraint[];
  primaryConstraint?: ResolvedQuotaConstraint;
}

export function resolveRouteHealth(input: ResolveRouteHealthInput): RouteHealth;
```

The resolver must select constraining buckets using the frozen spec precedence without manufacturing a universal availability percentage.

- [ ] **Step 4: Run domain tests**

```bash
npm test -- tests/usage/domain
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage/domain tests/usage/domain tests/usage/fixtures
git commit -m "feat(usage): add canonical quota domain"
```

---

### Task 2: SQLite-backed UsageStore and migrations

**Files:**
- Create: `src/usage/storage/usage-store.ts`
- Create: `src/usage/storage/sqlite-usage-store.ts`
- Create: `src/usage/storage/migrations.ts`
- Create: `src/usage/storage/schema/001_initial.sql`
- Create: `tests/usage/storage/sqlite-usage-store.test.ts`

**Interfaces:**
- Produces `UsageStore`.
- No caller outside `src/usage/storage/` may import `node:sqlite` directly.

- [ ] **Step 1: Write failing persistence tests**

Tests must prove:
- empty database migration;
- reopen persistence;
- foreign-key enforcement;
- transactional write behavior;
- retained subscription history after cancellation;
- quota snapshots retain provenance/confidence;
- no schema column exists for prompt/completion/API key/OAuth token.

Skeleton:

```ts
describe("SqliteUsageStore", () => {
  it("persists and reopens quota snapshots", async () => {});
  it("preserves cancelled subscription history", async () => {});
  it("enforces foreign keys", async () => {});
});
```

- [ ] **Step 2: Verify tests fail**

```bash
npm test -- tests/usage/storage/sqlite-usage-store.test.ts
```

- [ ] **Step 3: Implement `UsageStore` abstraction**

At minimum expose transaction-safe operations needed by later tasks:

```ts
export interface UsageStore {
  initialize(): Promise<void>;
  close(): Promise<void>;

  upsertProvider(value: Provider): Promise<void>;
  upsertAccount(value: Account): Promise<void>;
  upsertProduct(value: Product): Promise<void>;
  upsertSubscriptionPeriod(value: SubscriptionPeriod): Promise<void>;
  upsertModelIdentity(value: ModelIdentity): Promise<void>;
  upsertAccessRoute(value: AccessRoute): Promise<void>;
  upsertQuotaGroup(value: QuotaGroup): Promise<void>;
  upsertQuotaBucket(value: QuotaBucket): Promise<void>;
  upsertQuotaBinding(value: QuotaBinding): Promise<void>;
  upsertConsumptionRule(value: ConsumptionRule): Promise<void>;

  appendUsageEvents(values: UsageEvent[]): Promise<void>;
  appendCostEvents(values: CostEvent[]): Promise<void>;
  appendQuotaSnapshots(values: QuotaSnapshot[]): Promise<void>;

  getCurrentQuotaState(bucketId: string): Promise<QuotaSnapshot[]>;
  getRouteGraph(accessRouteId: string): Promise<RouteGraph>;
}
```

The implementation may enrich this interface if the query layer benefits, but it must retain responsibility boundaries.

- [ ] **Step 4: Implement initial migration and SQLite store**

Use the repo's Node 26+ baseline. If `node:sqlite` is suitable in the actual runtime, keep it isolated inside storage. Otherwise preserve the same `UsageStore` contract and document the proven incompatibility before choosing a dependency.

Canonical database location for production:

```text
$HOME/Library/Application Support/CMM Routers/Usage/cmm-usage.sqlite
```

Tests use temporary directories.

- [ ] **Step 5: Run storage tests and relevant repo tests**

```bash
npm test -- tests/usage/storage
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/usage/storage tests/usage/storage
git commit -m "feat(usage): add local usage store"
```

---

### Task 3: Dynamic registry and lifecycle

**Files:**
- Create: `src/usage/registry/usage-registry.ts`
- Create: `tests/usage/registry/usage-registry.test.ts`

**Interfaces:**
- Consumes: `UsageStore`, domain types.
- Produces dynamic provider/account/product/subscription/access-route lifecycle operations.

- [ ] **Step 1: Write failing registry tests**

Required cases:
- multiple accounts for one provider;
- enable/disable provider integration without history loss;
- cancel subscription period;
- later re-subscribe by creating a new period;
- same conceptual model through multiple products;
- unresolved provider model may exist without canonical ModelIdentity.

- [ ] **Step 2: Run and observe failure**

```bash
npm test -- tests/usage/registry
```

- [ ] **Step 3: Implement registry**

Core methods should remain explicit:

```ts
export interface UsageRegistry {
  registerProvider(input: RegisterProviderInput): Promise<Provider>;
  registerAccount(input: RegisterAccountInput): Promise<Account>;
  registerProduct(input: RegisterProductInput): Promise<Product>;
  startSubscription(input: StartSubscriptionInput): Promise<SubscriptionPeriod>;
  endSubscription(input: EndSubscriptionInput): Promise<SubscriptionPeriod>;
  registerModel(input: RegisterModelInput): Promise<ModelIdentity>;
  registerAccessRoute(input: RegisterAccessRouteInput): Promise<AccessRoute>;
  bindQuota(input: BindQuotaInput): Promise<QuotaBinding>;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/usage/registry
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/registry tests/usage/registry
git commit -m "feat(usage): add dynamic usage registry"
```

---

### Task 4: Adapter contract and manager

**Files:**
- Create: `src/usage/adapters/contract.ts`
- Create: `src/usage/adapters/adapter-manager.ts`
- Create: `tests/usage/adapters/contract.test.ts`

**Interfaces:**
- Produces the uniform capability-based adapter interface used by every provider integration.

- [ ] **Step 1: Write failing contract tests**

The shared suite must verify:
- capabilities are explicit;
- unsupported calls return normalized unsupported state rather than fake empty data;
- credentials cannot appear in normalized outputs;
- collection errors normalize auth/rate-limit/unavailable/protocol cases;
- adapters cannot use inference as a metadata probe.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/adapters/contract.test.ts
```

- [ ] **Step 3: Implement contract**

Required shape:

```ts
export interface UsageAdapter {
  readonly id: string;
  manifest(): UsageAdapterManifest;
  capabilities(): ReadonlySet<UsageAdapterCapability>;
  health(): Promise<UsageAdapterHealth>;
  discover(): Promise<UsageDiscoveryResult>;
  collectUsageEvents(cursor?: string): Promise<UsageEventBatch>;
  collectQuotaSnapshots(): Promise<QuotaSnapshotBatch>;
  collectCostEvents(cursor?: string): Promise<CostEventBatch>;
  refresh(): Promise<UsageRefreshResult>;
}
```

Optional capabilities should have a safe common representation rather than each adapter inventing behavior.

- [ ] **Step 4: Implement adapter manager and contract harness**

The manager handles enabled adapters and invocation; scheduling comes later.

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/usage/adapters
```

- [ ] **Step 6: Commit**

```bash
git add src/usage/adapters tests/usage/adapters
git commit -m "feat(usage): add usage adapter contract"
```

---

### Task 5: Event/snapshot ingestion and reconciliation

**Files:**
- Create: `src/usage/ingestion/event-ingestor.ts`
- Create: `src/usage/ingestion/snapshot-ingestor.ts`
- Create: `src/usage/reconciliation/reconciler.ts`
- Create: `tests/usage/reconciliation/reconciler.test.ts`
- Create: `tests/usage/integration/ingestion.test.ts`

**Interfaces:**
- Consumes normalized adapter/router data and `UsageStore`.
- Produces current reconciled quota state while retaining conflicting historical observations.

- [ ] **Step 1: Write failing reconciliation tests**

Must include:
- fresh authoritative exact vs local estimate;
- stale authoritative snapshot vs fresh router measurement;
- exact + estimated conflict retained for diagnostics;
- percentage-only value remains percentage-only;
- no back-calculated limit from percentage alone;
- incompatible units remain separate.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/reconciliation tests/usage/integration/ingestion.test.ts
```

- [ ] **Step 3: Implement ingestors**

Representative contracts:

```ts
export class UsageEventIngestor {
  constructor(private readonly store: UsageStore) {}
  ingest(events: readonly UsageEvent[]): Promise<void>;
}

export class QuotaSnapshotIngestor {
  constructor(private readonly store: UsageStore) {}
  ingest(snapshots: readonly QuotaSnapshot[]): Promise<void>;
}
```

Writes should be idempotent where upstream event identity permits.

- [ ] **Step 4: Implement reconciler**

```ts
export interface ReconciledQuotaState {
  bucketId: string;
  selected?: QuotaSnapshot;
  observations: QuotaSnapshot[];
  conflict: boolean;
  stale: boolean;
}

export function reconcileQuotaSnapshots(
  snapshots: readonly QuotaSnapshot[],
  now: Date,
): ReconciledQuotaState;
```

Preserve provenance; do not mutate historical observations.

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/usage/reconciliation tests/usage/integration
```

- [ ] **Step 6: Commit**

```bash
git add src/usage/ingestion src/usage/reconciliation tests/usage/reconciliation tests/usage/integration
git commit -m "feat(usage): reconcile usage events and snapshots"
```

---

### Task 6: Forecasting and alert engine

**Files:**
- Create: `src/usage/forecasting/quota-forecast.ts`
- Create: `src/usage/alerts/alert-engine.ts`
- Create: `tests/usage/forecasting/quota-forecast.test.ts`
- Create: `tests/usage/alerts/alert-engine.test.ts`

**Interfaces:**
- Produces advisory forecasts and deduplicated alerts from native bucket metrics.

- [ ] **Step 1: Write failing forecasting tests**

Prove:
- burn rate with enough samples;
- sustainable rate until reset;
- projected exhaustion before reset;
- reset boundary handling;
- insufficient history -> unknown;
- no cross-unit aggregation.

- [ ] **Step 2: Write failing alert tests**

Prove:
- >=75% known used fraction warning default;
- >=90% critical default;
- predicted exhaustion before reset -> critical;
- exhausted provider state -> exhausted;
- unknown remains unknown;
- dedup/cooldown prevents storms.

- [ ] **Step 3: Run and observe failure**

```bash
npm test -- tests/usage/forecasting tests/usage/alerts
```

- [ ] **Step 4: Implement forecast and alert engine**

Keep thresholds configurable and provider overrides possible.

Representative output:

```ts
export interface QuotaForecast {
  bucketId: string;
  confidence: Confidence;
  burnRate?: number;
  sustainableRate?: number;
  paceRatio?: number;
  predictedExhaustionAt?: string;
  willExhaustBeforeReset?: boolean;
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/usage/forecasting tests/usage/alerts
```

- [ ] **Step 6: Commit**

```bash
git add src/usage/forecasting src/usage/alerts tests/usage/forecasting tests/usage/alerts
git commit -m "feat(usage): add quota forecasting and alerts"
```

---

### Task 7: Usage service and safe collection scheduler

**Files:**
- Create: `src/usage/scheduler/collection-scheduler.ts`
- Create: `src/usage/service/usage-service.ts`
- Create: `src/usage/service/usage-query-service.ts`
- Create: `tests/usage/integration/usage-service.test.ts`

**Interfaces:**
- Orchestrates adapters, store, ingestors, reconciliation, forecasting, and health.
- Produces read-only query methods required by API and future routing.

- [ ] **Step 1: Write failing orchestration tests**

Must prove:
- only enabled adapters run;
- declared minimum refresh interval honored;
- backoff after failures;
- manual refresh works;
- adapter failure does not terminate service;
- clean shutdown;
- `getRouteHealth`, `getModelConstraints`, `getProviderPressure`, `getQuotaState`.

- [ ] **Step 2: Run and observe failure**

```bash
npm test -- tests/usage/integration/usage-service.test.ts
```

- [ ] **Step 3: Implement scheduler/service/query layer**

Required internal read contracts:

```ts
getRouteHealth(accessRouteId: string): Promise<RouteHealth>;
getModelConstraints(modelIdentityId: string): Promise<ModelConstraintView>;
getProviderPressure(providerId: string): Promise<ProviderPressureView>;
getQuotaState(quotaBucketId: string): Promise<QuotaStateView>;
```

Implement jitter/backoff in a testable way (inject clock/random source if that matches repo patterns).

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/usage/integration/usage-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/scheduler src/usage/service tests/usage/integration
git commit -m "feat(usage): add usage service orchestration"
```

---

### Task 8: Local read API and scoped auth

**Files:**
- Create: `src/usage/api/usage-routes.ts`
- Create: `src/usage/api/usage-auth.ts`
- Create: `tests/usage/api/usage-routes.test.ts`
- Modify: existing router HTTP route registration/bootstrap
- Modify: existing auth scope definitions if present

**Interfaces:**
- Consumes `UsageQueryService`.
- Exposes the frozen local API without granting inference privileges to the UI credential.

- [ ] **Step 1: Write failing API/auth tests**

Cover:

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

Must prove:
- read-only usage credential works on usage reads;
- same credential cannot invoke inference/tools;
- secrets never appear;
- provenance/freshness appears;
- refresh cannot cause inference;
- local loopback rules remain intact.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/api
```

- [ ] **Step 3: Implement routes and integrate with existing HTTP server**

Follow existing server conventions discovered during reconnaissance rather than introducing a second web stack.

- [ ] **Step 4: Run API + existing auth tests**

```bash
npm test -- tests/usage/api
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/api tests/usage/api
git add <actual-existing-http-auth-integration-files>
git commit -m "feat(usage): expose scoped local usage API"
```

---

### Task 9: Non-blocking CMM Routers telemetry bridge

**Files:**
- Create: `src/usage/service/router-telemetry-bridge.ts`
- Create: `tests/usage/integration/router-telemetry-bridge.test.ts`
- Modify: actual existing normalized provider response/inference completion integration point(s)

**Interfaces:**
- Converts already-known inference metadata into UsageEvents/CostEvents.
- Must not make successful inference dependent on telemetry persistence.

- [ ] **Step 1: Write failing bridge tests**

Prove:
- input/output/cache token metadata preserved when available;
- provider/model/access-route correlation preserved;
- storage failure is reported diagnostically but does not turn inference success into failure;
- no prompt/response content reaches UsageEvent;
- no new fallback/routing behavior appears.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/integration/router-telemetry-bridge.test.ts
```

- [ ] **Step 3: Implement bridge and hook into existing normalized response flow**

Do not duplicate provider parsing already performed by the inference adapter. Emit only safe metadata.

- [ ] **Step 4: Run integration + entire existing test suite**

```bash
npm test -- tests/usage/integration
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/service/router-telemetry-bridge.ts tests/usage/integration
git add <actual-existing-provider-integration-files>
git commit -m "feat(usage): capture router consumption telemetry"
```

---

### Task 10: Manual Subscription/API adapter

**Files:**
- Create: `src/usage/adapters/manual/adapter.ts`
- Create: `tests/usage/adapters/manual-adapter.test.ts`

**Interfaces:**
- Proves that a future unknown provider can be represented immediately without core changes.

- [ ] **Step 1: Write failing tests**

Create a fictional provider and prove the user can define:
- provider/account/product;
- two access routes;
- one shared quota;
- one model-specific quota;
- arbitrary reset policy;
- percentage-only snapshot;
- cancellation/history retention.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/adapters/manual-adapter.test.ts
```

- [ ] **Step 3: Implement**

Use domain validation, never provider-specific special cases.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/usage/adapters/manual-adapter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/adapters/manual tests/usage/adapters/manual-adapter.test.ts
git commit -m "feat(usage): add manual provider integration"
```

---

### Task 11: Generic OpenAI-Compatible adapter

**Files:**
- Create: `src/usage/adapters/openai-compatible/adapter.ts`
- Create: `tests/usage/adapters/openai-compatible-adapter.test.ts`

**Interfaces:**
- Supports base URL + secure API-key reference + optional model discovery + optional usage/balance mapping + manual quota graph.

- [ ] **Step 1: Write failing tests with a local fake HTTP server**

Prove:
- model discovery optional;
- usage endpoint optional;
- inference compatibility does not imply usage API compatibility;
- credentials are passed only to configured safe metadata endpoints;
- provider without usage endpoint still works with manual quota declarations.

- [ ] **Step 2: Verify failure**

```bash
npm test -- tests/usage/adapters/openai-compatible-adapter.test.ts
```

- [ ] **Step 3: Implement adapter**

Use injectable HTTP transport if that matches repo conventions so tests never contact the internet.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/usage/adapters/openai-compatible-adapter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/usage/adapters/openai-compatible tests/usage/adapters/openai-compatible-adapter.test.ts
git commit -m "feat(usage): add generic OpenAI-compatible integration"
```

---

### Task 12: Dedicated provider adapters

**Files:**
- Create/update each adapter directory under `src/usage/adapters/`
- Create provider-specific tests/fixtures under `tests/usage/adapters/`

**Interfaces:**
- All adapters implement the shared contract.
- Provider-specific behavior stays inside the adapter.

This task is intentionally executed provider-by-provider. Before implementing each adapter, verify the provider's **current** official/local supported usage mechanism and record the evidence in that adapter's README/source notes. Do not guess endpoint shapes from memory.

#### 12A — Command Code

- [ ] Write contract/fixture tests for simultaneous plan, rolling/window, weekly, and model-specific constraints where exposed.
- [ ] Implement safe collection from current supported non-inference source(s).
- [ ] Run adapter contract suite.
- [ ] Commit:

```bash
git commit -m "feat(usage): add Command Code integration"
```

#### 12B — Qoder

- [ ] Verify current supported local/official quota/usage source.
- [ ] Test discovered account quota/model information without inference.
- [ ] Implement.
- [ ] Run contract suite.
- [ ] Commit:

```bash
git commit -m "feat(usage): add Qoder integration"
```

#### 12C — Claude subscription

- [ ] Verify currently available non-inference usage source.
- [ ] Preserve percentage-only/reset-only information without inventing absolute limits.
- [ ] Test rolling/window + weekly coexistence.
- [ ] Implement.
- [ ] Commit:

```bash
git commit -m "feat(usage): add Claude subscription integration"
```

#### 12D — Google AI Pro

- [ ] Verify current usage/quota source.
- [ ] Represent split first-party/external pools and any applicable subgroup windows through ordinary buckets/bindings.
- [ ] Implement with no Google-specific branch in core quota resolver.
- [ ] Commit:

```bash
git commit -m "feat(usage): add Google AI Pro integration"
```

#### 12E — OpenAI

- [ ] Verify current official API usage/cost mechanisms available to the user's account type.
- [ ] Keep API billing/usage separate from consumer subscription usage.
- [ ] Implement only supported non-inference sources.
- [ ] Commit:

```bash
git commit -m "feat(usage): add OpenAI integration"
```

#### 12F — DeepSeek

- [ ] Verify current official balance/usage mechanisms.
- [ ] Combine provider balance snapshots with router-measured usage where appropriate without pretending they are the same metric.
- [ ] Implement.
- [ ] Commit:

```bash
git commit -m "feat(usage): add DeepSeek integration"
```

After all six:

```bash
npm test -- tests/usage/adapters
npm test
```

---

### Task 13: Native macOS client foundation

**Files:**
- Create: `apps/cmm-usage-macos/...`
- Create corresponding macOS tests

**Interfaces:**
- Uses the local CMM Usage API only.
- Uses a read-only usage credential stored in Keychain.
- Does not open/read SQLite directly.

- [ ] **Step 1: Establish the macOS target using the repo's preferred Apple project convention**

Keep the product public-ready: neutral names/icons/fixtures, no personal subscription defaults.

- [ ] **Step 2: Write client/API model tests**

Prove decoding of:
- provider pressure;
- access-route health;
- multiple quota buckets;
- provenance/confidence/freshness;
- alert summaries.

- [ ] **Step 3: Build the menu-bar surface**

Minimum behavior:
- overall state;
- provider/product list;
- status text/icon;
- reset/remaining summary where meaningful;
- manual refresh;
- open full window.

Never reduce heterogeneous provider limits to one fake percentage.

- [ ] **Step 4: Build full-window navigation**

Required sections:

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

- [ ] **Step 5: Build model/access-route detail**

Display all applicable buckets and primary constraining quota, including provenance.

- [ ] **Step 6: Add lifecycle surfaces**

Allow visibility/configuration of active/paused/cancelled/archive state without deleting history. Secret entry goes directly to Keychain-backed handling.

- [ ] **Step 7: Run Apple tests/build**

Use the actual generated project command selected by Astra, e.g. `swift test` for a Swift package or `xcodebuild` for an Xcode project. Capture exact successful command in documentation.

- [ ] **Step 8: Commit**

```bash
git add apps/cmm-usage-macos
git commit -m "feat(usage): add native macOS client"
```

---

### Task 14: Public-ready documentation and adapter authoring guide

**Files:**
- Create: `docs/cmm-usage/README.md`
- Create: `docs/cmm-usage/adapter-authoring.md`
- Create: `docs/cmm-usage/privacy.md`
- Create: `docs/cmm-usage/configuration.example.md`
- Create/update adapter-local README/source notes

**Interfaces:**
- Makes CMM Usage understandable and extensible to public contributors without exposing personal configuration.

- [ ] **Step 1: Document architecture in user-facing language**

Explain:
- why quotas are a graph;
- ModelIdentity vs AccessRoute;
- shared/model-specific/multi-window quotas;
- provenance/confidence;
- event vs snapshot collection.

- [ ] **Step 2: Document how to add a provider**

Include the choice between:
- Manual;
- Generic OpenAI-Compatible;
- declarative adapter;
- executable adapter.

- [ ] **Step 3: Document privacy model**

Explicitly state that prompts/responses and secrets are outside usage persistence.

- [ ] **Step 4: Audit all examples/fixtures**

Search for personal/user-specific content:

```bash
git grep -n -E '/Users/|chris|christian|Bearer |sk-|api[_-]?key|oauth|refresh[_-]?token' -- \
  ':!docs/superpowers/specs/2026-09-12-cmm-usage-design.md'
```

Review every hit; do not blindly assume every match is a leak.

- [ ] **Step 5: Commit**

```bash
git add docs/cmm-usage src/usage/adapters tests/usage
git commit -m "docs(usage): add public extension and privacy guide"
```

---

### Task 15: Full verification and operational proof

**Files:**
- Create: `docs/cmm-usage/verification.md`
- Add/fix tests only where verification exposes a concrete gap.

- [ ] **Step 1: Run full TypeScript test suite**

```bash
npm test
```

Expected: all existing and CMM Usage tests pass.

- [ ] **Step 2: Run typecheck/lint/build using existing repo scripts**

Discover exact commands from `package.json`, then run every relevant mandatory check. Record exact commands/results in `verification.md`.

- [ ] **Step 3: Run macOS build/tests**

Record the exact successful command and target.

- [ ] **Step 4: Prove canonical scenarios**

Use deterministic test/fixture outputs for:
- model-specific API;
- shared free pool;
- Command Code-style overlapping quotas;
- Google AI Pro-style split pools;
- Claude/OpenAI multi-window constraints;
- balance-only API;
- unknown provider via Manual adapter.

- [ ] **Step 5: Prove collection cannot trigger inference**

Use adapter mocks/spies or transport-level assertions to show metadata refresh never calls an inference endpoint.

- [ ] **Step 6: Prove failure isolation**

Simulate:
- corrupt provider metadata;
- provider 401;
- provider 429;
- stale snapshot;
- SQLite write failure.

Existing inference behavior must remain operational where the failure is usage-only.

- [ ] **Step 7: Security/public-release pre-audit**

Check:
- repository secrets;
- personal paths/IDs;
- database artifacts;
- fixture provenance;
- logs/redaction;
- ignored local configuration.

This is a pre-audit only. Actual public publication occurs after real-world operational validation.

- [ ] **Step 8: Verify clean diff**

```bash
git diff --check
git status --short
git log --oneline --decorate --max-count=20
```

- [ ] **Step 9: Commit verification evidence**

```bash
git add docs/cmm-usage/verification.md
git commit -m "test(usage): document operational verification"
```

---

## Final implementation acceptance gate

Do not call CMM Usage complete merely because it builds.

Before handoff, demonstrate all of the following from tests/evidence:

- many-to-many quota graph works;
- shared and model-specific buckets coexist;
- arbitrary windows coexist;
- same model through independent access routes works;
- dynamic provider/subscription lifecycle preserves history;
- Manual adapter can model a provider unknown to the codebase;
- Generic OpenAI-Compatible path works without assuming billing compatibility;
- source/confidence/freshness survives from adapter to API/UI;
- forecasting returns unknown when evidence is insufficient;
- adapter errors do not take down inference;
- usage storage contains no prompt/completion/secrets;
- UI uses scoped read-only local API;
- no automatic rerouting exists;
- full existing test suite remains green;
- public-safe docs/fixtures/config examples are present.

## Execution philosophy for Astra

The frozen spec defines product truth. This plan defines the required engineering milestones and verification evidence.

Within those boundaries, Astra is explicitly encouraged to:
- inspect and understand existing CMM Routers patterns before coding;
- improve internal decomposition where it materially simplifies correctness;
- choose stronger algorithms/data structures than those sketched here;
- reuse existing repo abstractions instead of creating duplicate infrastructure;
- add tests beyond this plan when they expose meaningful edge cases;
- adjust incidental filenames/integration points to the actual repository;
- surface and justify any discovered incompatibility before altering a frozen product contract.

The objective is not literal obedience to pseudocode. The objective is a robust implementation of the approved product.
