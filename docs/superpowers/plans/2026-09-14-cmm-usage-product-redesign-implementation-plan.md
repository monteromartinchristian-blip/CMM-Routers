# CMM Usage Product Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved CMM Usage presentation/catalog architecture and Hermes-quality native macOS UX while preserving the existing canonical Usage domain, provider-native quota semantics, route-scoped visibility, security boundaries, and CMMChat catalog reuse.

**Architecture:** Keep adapters, canonical Usage entities, SQLite history/snapshots, quota resolution, and `UsageQueryService` as the accounting authority. Add a product-facing presentation layer composed of `ProviderDirectory`, `VisibilityStore`, `PresentationCatalogService`, safe catalog endpoints, and a separately-authorized `ConnectionManagementService`; the native macOS client consumes those safe DTOs and never receives credential references. UI selection is by `AccessRoute`, not `ModelIdentity`, and hidden routes continue to participate in accounting.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, SQLite, Vitest, Swift 6 / SwiftUI, macOS Keychain, Swift Package Manager.

**Spec:** `docs/superpowers/specs/2026-09-14-cmm-usage-hermes-parity-product-redesign-design.md`

## Global Constraints

- Preserve the existing canonical Usage domain and quota semantics; product presentation is a projection above it.
- `PresentationCatalogService` is the only product-facing catalog authority; never substitute `ProviderRegistry.listModels()`.
- The selectable unit is `AccessRoute`; v1 visibility is global but route-scoped. Hiding one provider route must not hide sibling routes of the same `ModelIdentity`.
- Visibility affects model-selection surfaces only. It must not stop collection, delete bindings/snapshots/history/costs, alter totals, or remove hidden routes from Usage accounting views.
- Primary `AccessOffer` categories are exactly `FREE | PROMO | INCLUDED | TRIAL | PAYG | UNKNOWN`.
- Preserve provider-native metrics and scopes. Do not manufacture money, credits, tokens, requests, percentages, denominators, resets, or route attribution that the evidence does not support.
- A shared pool is represented once with its affected routes; supplemental balances are not independent hard constraints unless provider semantics establish that.
- Normal UI/API must not expose `credentialRef`, Keychain URLs, env references, auth paths, secrets, raw account identifiers, raw canonical IDs as primary text, or arbitrary adapter settings JSON.
- Read/catalog authority remains separate from connection/secret mutation authority. CMMChat receives catalog reads without automatic provider-secret mutation authority.
- Supported providers remain visible when disconnected, and provider failures remain isolated.
- Keep Accounts/Subscriptions, API Keys, and Custom Endpoints as separate connection experiences; generic OpenAI-compatible endpoints support Test, Save, model discovery, default model, and safe key handling.
- The native UI follows the supplied Hermes screenshots for density, hierarchy, grouping, search, toggles, panel proportions, and visual calm while adding CMM quota/offer intelligence.
- Major screens require a real-app screenshot review and at least one visual iteration after the first review. Passing tests is not visual acceptance.
- Use public-safe fixtures only. Never commit personal `config/usage.json`, credentials, account IDs, real snapshots, or dogfood values.
- Do not resume Claude/DeepSeek/OpenRouter dogfooding or the old Tasks 14/15 while executing this redesign.
- Run focused Usage Vitest suites serially (`--no-file-parallelism --maxWorkers 1`) to avoid known nested-concurrency instability.

---

### Task 1: Presentation types and ProviderDirectory

**Files:**
- Create: `src/usage/presentation/types.ts`
- Create: `src/usage/presentation/provider-directory.ts`
- Create: `tests/usage/presentation/provider-directory.test.ts`

**Interfaces:**
- Produces `AccessOfferKind`, `AccessOfferSummary`, `QuotaSummary`, `CatalogRouteEntry`, `ProviderDirectoryEntry`, `VisibilityPreference`, `CatalogProviderView`, and presentation-safe connection state types.
- Produces `ProviderDirectory.list()` and `ProviderDirectory.get(integrationType)` using the existing supported integration inventory without requiring active configuration.
- Provider directory output contains only product-safe metadata and capability booleans; no adapter settings or credentials.

- [ ] **Step 1: Write the failing ProviderDirectory tests.**

```ts
it("lists supported providers even when none are configured", () => {
  const directory = createDefaultProviderDirectory([]);
  expect(directory.list().map((entry) => entry.integrationType)).toEqual(
    expect.arrayContaining(["command-code", "chatgpt-subscription", "openrouter"]),
  );
});

it("separates support, connection and enablement state", () => {
  const directory = createDefaultProviderDirectory([
    { id: "cc", type: "command-code", enabled: false, settings: {} },
  ]);
  const commandCode = directory.get("command-code");
  expect(commandCode?.state).toBe("disabled");
  expect(commandCode?.connectedInstanceCount).toBe(1);
});
```

- [ ] **Step 2: Verify RED.**

Run: `npx vitest run tests/usage/presentation/provider-directory.test.ts --no-file-parallelism --maxWorkers 1`

Expected: FAIL because the presentation directory does not yet exist.

- [ ] **Step 3: Implement the safe presentation types and directory.**

The directory must derive supported integration types from the existing integration definitions/catalog metadata or one adjacent explicit descriptor table, with friendly labels/categories/connection methods/capabilities. Do not instantiate adapters to list disconnected providers.

- [ ] **Step 4: Verify GREEN and typecheck the new interfaces.**

Run: `npx vitest run tests/usage/presentation/provider-directory.test.ts --no-file-parallelism --maxWorkers 1 && npm run typecheck`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/presentation/types.ts src/usage/presentation/provider-directory.ts tests/usage/presentation/provider-directory.test.ts
git commit -m "feat(usage): add provider presentation directory"
```

---

### Task 2: Route visibility persistence and resolution

**Files:**
- Create: `src/usage/storage/schema/003_catalog_visibility.sql`
- Modify: `src/usage/storage/migrations.ts`
- Modify: `src/usage/storage/usage-store.ts`
- Modify: `src/usage/storage/sqlite-usage-store.ts`
- Create: `src/usage/presentation/visibility-store.ts`
- Create: `tests/usage/presentation/visibility-store.test.ts`
- Modify: `tests/usage/storage/sqlite-usage-store.test.ts`

**Interfaces:**
- Adds persisted `VisibilityPreference` rows keyed by `scope` plus optional provider/product/route selectors.
- Adds `UsageStore.listVisibilityPreferences(scope)` and `UsageStore.upsertVisibilityPreference(preference)`.
- Produces `VisibilityStore.resolveRoute({ routeId, productId, providerId, workspaceId? })` and group-state helpers.
- v1 writes/reads `global`; schema remains compatible with future `workspace:<id>` precedence.

- [ ] **Step 1: Write failing persistence/resolution tests.**

```ts
it("hides one route without hiding a sibling route for the same model", async () => {
  await visibility.set({ scope: "global", routeId: "route:openrouter:claude", state: "hidden" });
  expect(await visibility.resolveRoute(openRouterClaude)).toBe("hidden");
  expect(await visibility.resolveRoute(anthropicClaude)).toBe("visible");
});

it("persists global visibility across SQLite reopen", async () => {
  await store.upsertVisibilityPreference({ scope: "global", routeId: "route:qwen", state: "hidden" });
  await store.close();
  const reopened = await openStore(dbPath);
  expect(await reopened.listVisibilityPreferences("global")).toContainEqual(
    expect.objectContaining({ routeId: "route:qwen", state: "hidden" }),
  );
});
```

Also assert hiding a route leaves quota bindings/snapshots/history queryable.

- [ ] **Step 2: Verify RED.**

Run: `npx vitest run tests/usage/presentation/visibility-store.test.ts tests/usage/storage/sqlite-usage-store.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 3: Add migration/store methods and minimal resolver.**

Resolution order must be future-ready: workspace route → global route → group preference → visible default. v1 public methods only write `global` unless a test explicitly exercises precedence internals.

- [ ] **Step 4: Verify GREEN plus accounting independence.**

Run: `npx vitest run tests/usage/presentation/visibility-store.test.ts tests/usage/storage/sqlite-usage-store.test.ts tests/usage/integration/usage-service.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/storage/schema/003_catalog_visibility.sql src/usage/storage/migrations.ts src/usage/storage/usage-store.ts src/usage/storage/sqlite-usage-store.ts src/usage/presentation/visibility-store.ts tests/usage/presentation/visibility-store.test.ts tests/usage/storage/sqlite-usage-store.test.ts
git commit -m "feat(usage): add global route visibility"
```

---

### Task 3: PresentationCatalogService, offers, quota summaries, and shared pools

**Files:**
- Create: `src/usage/presentation/access-offer.ts`
- Create: `src/usage/presentation/quota-presentation.ts`
- Create: `src/usage/presentation/presentation-catalog-service.ts`
- Create: `tests/usage/presentation/presentation-catalog-service.test.ts`
- Create: `tests/usage/fixtures/catalog-scenarios.ts`

**Interfaces:**
- `PresentationCatalogService.listProviders()`, `.listRoutes()`, `.getRoute(routeId)`, `.listPromotions()`, `.listVisibleRoutes()`.
- `projectAccessOffer(...)` returns one of the six primary kinds plus evidence/provenance fields.
- `projectQuotaSummary(...)` preserves native metric, unit, scope, used/remaining/limit/reset/freshness/status/constraining state and shared-pool route references.
- Supplemental Command Code purchased/free balances remain observable but non-constraining.

- [ ] **Step 1: Add the public-safe fixture and failing service tests.**

The fixture must include fictitious Command Code/GOAT monthly-plan balance, purchased balance, free balance, 5-hour window, weekly window, subscription period, unknown rolling reset instants, API/PAYG, one FREE route, one PROMO route, a disconnected supported provider, unknown limits, percentage-only quota, token quota, request quota, monetary balance, provider-defined units, and one shared pool used by multiple routes.

```ts
it("preserves heterogeneous provider-native metrics", async () => {
  const quotas = await catalog.listQuotaSummaries();
  expect(quotas).toEqual(expect.arrayContaining([
    expect.objectContaining({ metric: expect.objectContaining({ kind: "percentage" }) }),
    expect.objectContaining({ metric: expect.objectContaining({ kind: "credits" }) }),
    expect.objectContaining({ metric: expect.objectContaining({ kind: "tokens" }) }),
    expect.objectContaining({ metric: expect.objectContaining({ kind: "requests" }) }),
    expect.objectContaining({ metric: expect.objectContaining({ kind: "currency" }) }),
  ]));
});

it("represents a shared pool once and lists affected routes", async () => {
  const shared = (await catalog.listQuotaSummaries()).filter((q) => q.scope.kind === "shared_pool");
  expect(shared).toHaveLength(1);
  expect(shared[0]?.affectedRouteIds).toHaveLength(2);
});
```

Add normative sibling-route visibility and promotion-transition tests.

- [ ] **Step 2: Verify RED.**

Run: `npx vitest run tests/usage/presentation/presentation-catalog-service.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 3: Implement offer/quota projection and catalog service.**

Do not infer `FREE`/`PROMO` from model names. Evidence priority is official billing/quota metadata → official model/account metadata → official CLI/app state → current docs → manual observation. Unknown denominator/reset/cost remains unknown. A quota applying to a route is distinct from attributable consumption.

- [ ] **Step 4: Verify GREEN and regression-check quota resolution.**

Run: `npx vitest run tests/usage/presentation/presentation-catalog-service.test.ts tests/usage/domain/quota-resolution.test.ts tests/usage/adapters/command-code-adapter.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/presentation/access-offer.ts src/usage/presentation/quota-presentation.ts src/usage/presentation/presentation-catalog-service.ts tests/usage/presentation/presentation-catalog-service.test.ts tests/usage/fixtures/catalog-scenarios.ts
git commit -m "feat(usage): add presentation catalog"
```

---

### Task 4: Safe reusable catalog API

**Files:**
- Create: `src/usage/api/catalog-routes.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `src/http/server.ts`
- Create: `tests/usage/api/catalog-routes.test.ts`
- Modify: `tests/usage/api/usage-routes.test.ts`

**Interfaces:**
- Adds safe reads:
  - `GET /v1/cmm/usage/catalog/providers`
  - `GET /v1/cmm/usage/catalog/routes`
  - `GET /v1/cmm/usage/catalog/routes/:id`
  - `GET /v1/cmm/usage/catalog/promotions`
  - `GET /v1/cmm/usage/catalog/visibility`
- Catalog route DTO is directly reusable by CMMChat for provider/product grouping, route identity, friendly labels, offer badge, capabilities, availability, visibility, and minimal freshness.

- [ ] **Step 1: Write failing endpoint/security tests.**

```ts
it("never exposes credential references or raw adapter settings", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/cmm/usage/catalog/providers", headers: readAuth });
  expect(response.statusCode).toBe(200);
  const text = response.body;
  expect(text).not.toContain("credentialRef");
  expect(text).not.toContain("keychain://");
  expect(text).not.toContain("managementCredentialRef");
});
```

Also assert disconnected providers are returned, route hiding is route-scoped, and read auth can fetch but cannot mutate visibility.

- [ ] **Step 2: Verify RED.**

Run: `npx vitest run tests/usage/api/catalog-routes.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 3: Register catalog reads through existing auth conventions.**

Use `redactObject` as defense in depth, but design DTOs so forbidden fields never enter the response object.

- [ ] **Step 4: Verify GREEN.**

Run: `npx vitest run tests/usage/api/catalog-routes.test.ts tests/usage/api/usage-routes.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/api/catalog-routes.ts src/usage/runtime/production-runtime.ts src/http/server.ts tests/usage/api/catalog-routes.test.ts tests/usage/api/usage-routes.test.ts
git commit -m "feat(usage): expose safe provider catalog API"
```

---

### Task 5: Secure connection management and privileged mutation API

**Files:**
- Create: `src/usage/runtime/managed-config-store.ts`
- Create: `src/usage/runtime/credential-writer.ts`
- Create: `src/usage/service/connection-management-service.ts`
- Create: `src/usage/api/connection-auth.ts`
- Create: `src/usage/api/connection-routes.ts`
- Modify: `src/usage/runtime/config.ts`
- Modify: `src/usage/runtime/configured-runtime.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `src/http/server.ts`
- Create: `tests/usage/runtime/managed-config-store.test.ts`
- Create: `tests/usage/service/connection-management-service.test.ts`
- Create: `tests/usage/api/connection-routes.test.ts`

**Interfaces:**
- `CredentialWriter.write(instanceId, secret): Promise<{ credentialRef: string; hint?: string }>` and `.remove(reference)`; production implementation writes Keychain, tests inject memory writer.
- `ManagedConfigStore` persists non-secret integration configuration and preserves history by deleting/disabling only active config.
- `ConnectionManagementService.connectWithApiKey`, `.connectAccount`, `.addCustomEndpoint`, `.disconnect`, `.enable`, `.disable`, `.testConnection`, `.refresh`.
- Separate mutation token/authority; existing read token is insufficient for any secret/config mutation.
- Custom OpenAI-compatible endpoint supports endpoint URL, default model, optional usage/billing endpoints, model discovery, automatic/manual/unknown quota mode, and safe key storage.

- [ ] **Step 1: Write failing service/auth tests.**

```ts
it("stores submitted secrets through CredentialWriter and persists only the reference", async () => {
  await connections.connectWithApiKey("openrouter", "secret-value");
  expect(memoryCredentialWriter.values()).toContain("secret-value");
  expect(JSON.stringify(await managedConfig.read())).not.toContain("secret-value");
});

it("rejects mutation with the catalog read token", async () => {
  const response = await app.inject({ method: "POST", url: "/v1/cmm/usage/connections/api-key", headers: readAuth, payload: safePayload });
  expect(response.statusCode).toBe(401);
});
```

Also test disconnect preserves canonical SQLite history/visibility, one failing provider does not disturb others, and no response contains a secure reference.

- [ ] **Step 2: Verify RED.**

Run: `npx vitest run tests/usage/runtime/managed-config-store.test.ts tests/usage/service/connection-management-service.test.ts tests/usage/api/connection-routes.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 3: Implement the smallest secure mutation layer.**

Reuse the Task 13 secure/local credential mechanisms already present where possible; do not invent a parallel secret architecture. Runtime reload/refresh must happen through existing configured-runtime lifecycle hooks rather than ad-hoc adapter mutation.

- [ ] **Step 4: Verify GREEN plus credential/resolution regressions.**

Run: `npx vitest run tests/usage/runtime/managed-config-store.test.ts tests/usage/service/connection-management-service.test.ts tests/usage/api/connection-routes.test.ts tests/usage/runtime/credential-resolver.test.ts tests/usage/runtime/configured-runtime.test.ts --no-file-parallelism --maxWorkers 1`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/runtime/managed-config-store.ts src/usage/runtime/credential-writer.ts src/usage/service/connection-management-service.ts src/usage/api/connection-auth.ts src/usage/api/connection-routes.ts src/usage/runtime/config.ts src/usage/runtime/configured-runtime.ts src/usage/runtime/production-runtime.ts src/http/server.ts tests/usage/runtime/managed-config-store.test.ts tests/usage/service/connection-management-service.test.ts tests/usage/api/connection-routes.test.ts
git commit -m "feat(usage): add secure connection management"
```

---

### Task 6: Public demo fixture and Swift catalog/connection client

**Files:**
- Create: `src/usage/demo/public-safe-catalog-fixture.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/APIModels.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/UsageAPIClient.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/Module.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/UsageCredentialStore.swift`
- Modify: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/UsageDecodingTests.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageContractTests/main.swift`

**Interfaces:**
- `CMM_USAGE_DEMO_FIXTURE=1` starts the real local Usage runtime with only fictitious public-safe catalog/usage state.
- Swift adds strongly-typed catalog/provider/route/offer/quota DTOs and separate read vs connection-mutation credentials.
- `UsageAPIClient` adds catalog reads and privileged connection/visibility mutations without logging secrets.

- [ ] **Step 1: Add failing Swift decoding/contract tests and backend fixture tests.**

Tests must assert all six offer kinds decode, native metrics remain distinct, unknown resets/limits decode as optional/unknown, shared pools decode once with affected route IDs, and forbidden credential fields are absent.

- [ ] **Step 2: Verify RED.**

Run: `cd apps/cmm-usage-macos && swift test`

- [ ] **Step 3: Implement DTOs/client and explicit demo-fixture boot path.**

Keep Keychain use off the SwiftUI main thread. Demo mode must never read personal Usage config or real Keychain credentials.

- [ ] **Step 4: Verify GREEN.**

Run: `cd apps/cmm-usage-macos && swift test && swift run CMMUsageContractTests`

- [ ] **Step 5: Commit.**

```bash
git add src/usage/demo/public-safe-catalog-fixture.ts src/usage/runtime/production-runtime.ts apps/cmm-usage-macos/Sources/CMMUsageCore apps/cmm-usage-macos/Tests/CMMUsageCoreTests apps/cmm-usage-macos/Sources/CMMUsageContractTests/main.swift
git commit -m "feat(usage): add public catalog fixture and native client contract"
```

---

### Task 7: Native navigation and Providers connection experience

**Files:**
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/MainWindowView.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageAppModel.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageComponents.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/SectionViews.swift`
- Create: `apps/cmm-usage-macos/Sources/CMMUsageApp/ProviderViews.swift`
- Create: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/ProviderPresentationTests.swift`

**Interfaces:**
- Primary navigation: Overview, Quotas, Models, Providers, Free & Promo, History, Costs, Alerts, Settings.
- Providers internally segments Accounts, API Keys, Custom Endpoints; Local Models may remain future-ready.
- Connected and available providers appear together; API key UI only shows a safe hint; custom endpoint form exposes semantic fields, Test/Save/discovery, never raw config JSON.

- [ ] **Step 1: Add failing presenter/view-model tests.**

Assert provider grouping, connected/available states, safe key hint formatting, actionable empty states, isolated degraded-provider state, and semantic navigation destinations.

- [ ] **Step 2: Verify RED with Swift tests.**

Run: `cd apps/cmm-usage-macos && swift test`

- [ ] **Step 3: Implement compact native Providers/navigation UI.**

Use Hermes screenshots as the interaction/density reference: restrained chrome, thin separators, compact rows, subdued secondary copy, clear connection badges, and modal proportions. Avoid giant cards and debug labels.

- [ ] **Step 4: Verify GREEN and release build.**

Run: `cd apps/cmm-usage-macos && swift test && swift build -c release`

- [ ] **Step 5: Commit.**

```bash
git add apps/cmm-usage-macos/Sources/CMMUsageApp apps/cmm-usage-macos/Tests/CMMUsageCoreTests/ProviderPresentationTests.swift
git commit -m "feat(usage-macos): redesign provider connections"
```

---

### Task 8: Models editor and CMMChat picker preview

**Files:**
- Create: `apps/cmm-usage-macos/Sources/CMMUsageApp/ModelCatalogViews.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageAppModel.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageComponents.swift`
- Create: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/ModelCatalogPresentationTests.swift`

**Interfaces:**
- Models editor: instant search, Provider → Product grouping, route-scoped row toggles, tri-state group controls, access badges, headline quota/access info, filters (All/Included/Free/Promo/Trial/PAYG/Hidden), `Add provider…`.
- CMMChat picker preview consumes the same `CatalogRouteEntry` array and visibility resolution; compact rows show model/provider/product/offer only, plus `Edit models…`.

- [ ] **Step 1: Add failing grouping/filter/visibility tests.**

```swift
func testHidingOpenRouterClaudeKeepsAnthropicAndGoogleClaudeVisible() throws {
    let visible = CatalogPresenter.visibleRoutes(routes)
    XCTAssertTrue(visible.contains(where: { $0.routeId == "anthropic-claude" }))
    XCTAssertTrue(visible.contains(where: { $0.routeId == "google-claude" }))
    XCTAssertFalse(visible.contains(where: { $0.routeId == "openrouter-claude" }))
}
```

Also test mixed group state, search matching friendly names/provider/product, and picker/editor sharing identical visible route IDs.

- [ ] **Step 2: Verify RED.**

Run: `cd apps/cmm-usage-macos && swift test`

- [ ] **Step 3: Implement the editor and picker preview.**

Keyboard focus/order must follow visual order; toggles need meaningful accessibility values and cannot communicate state by color alone.

- [ ] **Step 4: Verify GREEN and release build.**

Run: `cd apps/cmm-usage-macos && swift test && swift build -c release`

- [ ] **Step 5: Commit.**

```bash
git add apps/cmm-usage-macos/Sources/CMMUsageApp/ModelCatalogViews.swift apps/cmm-usage-macos/Sources/CMMUsageApp/UsageAppModel.swift apps/cmm-usage-macos/Sources/CMMUsageApp/UsageComponents.swift apps/cmm-usage-macos/Tests/CMMUsageCoreTests/ModelCatalogPresentationTests.swift
git commit -m "feat(usage-macos): add route catalog editor"
```

---

### Task 9: Overview, Quotas, Free & Promo, and secondary operational views

**Files:**
- Create: `apps/cmm-usage-macos/Sources/CMMUsageApp/OverviewView.swift`
- Create: `apps/cmm-usage-macos/Sources/CMMUsageApp/QuotaViews.swift`
- Create: `apps/cmm-usage-macos/Sources/CMMUsageApp/FreePromoView.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/SectionViews.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageComponents.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/UsagePresentation.swift`
- Create: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/QuotaPresentationTests.swift`

**Interfaces:**
- Overview answers connected / near exhaustion / reset soon / free-promo / degraded / needs attention without mirroring backend tables.
- Quotas is authoritative and includes hidden routes, all simultaneous windows, native metrics, scopes, freshness, resets, constraining state, and one shared-pool row per pool.
- Free & Promo shows active/new/expiring/exhausted/available-but-disconnected opportunities with evidence-based categories.
- History/Costs/Alerts/Settings use actionable empty states and preserve existing real data; unavailable cost is Unknown, never zero.

- [ ] **Step 1: Add failing formatting/presentation tests.**

Cover `61% used`, `35 credits remaining`, `800K tokens remaining`, `42 / 100 requests remaining`, `$7.31 balance remaining`, provider-defined units, no percentage bar with unknown denominator, `No reset` vs `Unknown reset`, primary constraint prominence metadata, supplemental-balance subordination, and one shared pool affecting multiple routes.

- [ ] **Step 2: Verify RED.**

Run: `cd apps/cmm-usage-macos && swift test`

- [ ] **Step 3: Implement the screens and reusable quota/offer components.**

Use progress bars/rings only where a real denominator exists. Keep raw provenance for detail inspectors; primary rows show concise freshness such as `Updated 2m ago`.

- [ ] **Step 4: Verify GREEN and release build.**

Run: `cd apps/cmm-usage-macos && swift test && swift build -c release`

- [ ] **Step 5: Commit.**

```bash
git add apps/cmm-usage-macos/Sources/CMMUsageApp apps/cmm-usage-macos/Sources/CMMUsageCore/UsagePresentation.swift apps/cmm-usage-macos/Tests/CMMUsageCoreTests/QuotaPresentationTests.swift
git commit -m "feat(usage-macos): redesign quota dashboard"
```

---

### Task 10: Menu bar and deep links

**Files:**
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/MenuBarUsageView.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/CMMUsageApp.swift`
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageApp/UsageAppModel.swift`
- Create: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/MenuBarPresentationTests.swift`

**Interfaces:**
- Menu bar shows friendly product identity, primary constraining quota, concise simultaneous windows, useful reset/renewal, warning/degraded state, Free & Promo count, Refresh, and Open CMM Usage.
- No fake universal aggregate, canonical IDs, or text dump.
- Deep links open the corresponding native destination (Models, Providers, Quotas, Free & Promo).

- [ ] **Step 1: Write failing menu-model tests.**

Assert GOAT-friendly naming, unknown reset handling, no aggregate percentage when metrics are heterogeneous, and deep-link destination mapping.

- [ ] **Step 2: Verify RED.**

Run: `cd apps/cmm-usage-macos && swift test`

- [ ] **Step 3: Implement compact menu/deep-link behavior.**

- [ ] **Step 4: Verify GREEN and release build.**

Run: `cd apps/cmm-usage-macos && swift test && swift build -c release`

- [ ] **Step 5: Commit.**

```bash
git add apps/cmm-usage-macos/Sources/CMMUsageApp/MenuBarUsageView.swift apps/cmm-usage-macos/Sources/CMMUsageApp/CMMUsageApp.swift apps/cmm-usage-macos/Sources/CMMUsageApp/UsageAppModel.swift apps/cmm-usage-macos/Tests/CMMUsageCoreTests/MenuBarPresentationTests.swift
git commit -m "feat(usage-macos): redesign usage menu bar"
```

---

### Task 11: Demo launch and mandatory screenshot-based visual iteration

**Files:**
- Modify as required by visible findings: `apps/cmm-usage-macos/Sources/CMMUsageApp/*.swift`
- Store only ignored review artifacts under: `.superpowers/sdd/2026-09-14-cmm-usage-product-redesign-implementation-plan/visual/`

**Interfaces:**
- Real app launches against `CMM_USAGE_DEMO_FIXTURE=1`.
- Capture: Overview, Quotas, Models, Providers/Accounts, Providers/API Keys, Providers/Custom Endpoints, Free & Promo, compact picker preview, and menu bar.
- Compare directly against all six supplied Hermes screenshots for density, hierarchy, panel proportions, search, grouping, toggles, connected state, secondary text, and visual calm.

- [ ] **Step 1: Build and launch the real demo app.**

Run the release or debug executable with the explicit public-safe demo fixture. Do not point this visual pass at personal Usage config.

- [ ] **Step 2: Capture the first screenshot set.**

Use the native app/UI tooling available in the environment. Record each screenshot path and a short visible-findings table in the SDD ledger.

- [ ] **Step 3: Compare the first pass with Hermes and record concrete weaknesses.**

For every screen, assess: information density, accidental whitespace, row height, search placement, group hierarchy, title hierarchy, badge/toggle weight, separator/border subtlety, modal width/height, alignment, empty-state dominance, raw/debug vocabulary, and whether unrelated provider failures visually leak.

- [ ] **Step 4: Perform at least one implementation iteration based on visible findings.**

For each code change, add or update presenter tests first where behavior changes; purely visual SwiftUI adjustments may use the existing visual loop plus build/contract verification.

- [ ] **Step 5: Rebuild, relaunch, and capture the second screenshot set.**

Do not accept the first pass. The second pass must visibly address the weaknesses recorded in Step 3.

- [ ] **Step 6: Verify accessibility and native interaction.**

Check keyboard focus, VoiceOver labels/state announcements where tooling permits, no color-only communication, text scaling, and focus order matching visual order. Record any tooling limitation without claiming a check was performed when it was not.

- [ ] **Step 7: Commit the visual polish only; never commit screenshots/ledger artifacts.**

```bash
git add apps/cmm-usage-macos/Sources/CMMUsageApp apps/cmm-usage-macos/Tests/CMMUsageCoreTests
git commit -m "fix(usage-macos): polish Hermes parity interactions"
```

---

### Task 12: Full Definition-of-Done verification and requirement audit

**Files:**
- Modify only if verification exposes a real defect; every defect fix follows RED → minimal implementation → GREEN.
- Update SDD ledger with the requirement-by-requirement evidence matrix.

**Interfaces:**
- No new product interface; this task proves the spec is satisfied.

- [ ] **Step 1: Run the complete serial Usage test suite.**

Run: `npx vitest run tests/usage --no-file-parallelism --maxWorkers 1`

- [ ] **Step 2: Run TypeScript validation/build and diff hygiene.**

Run: `npm run typecheck && npm run build && git diff --check`

- [ ] **Step 3: Run Swift validation with full Xcode toolchain.**

If `xcode-select -p` points only to CommandLineTools, locate the installed full Xcode and invoke its toolchain without changing the user's global selection unnecessarily.

Run from `apps/cmm-usage-macos`:

```bash
swift test
swift run CMMUsageContractTests
swift build -c release
```

- [ ] **Step 4: Run a security leakage scan.**

Search product/API fixture/test output and staged diff for `credentialRef`, `keychain://`, secret-like literal values, personal paths, raw account IDs, and real dogfood snapshots. Any legitimate internal-only occurrence must be reviewed against the normal-UI/API boundary; nothing personal may be staged.

- [ ] **Step 5: Audit all 24 Definition-of-Done items from spec §53.**

Create a ledger matrix with one row per item and direct evidence (test, endpoint response, screenshot, or inspected implementation). Missing/indirect evidence counts as incomplete and must trigger implementation or stronger verification.

- [ ] **Step 6: Audit all normative §53.1 examples.**

Prove: OpenRouter-Claude hidden while Anthropic/Google sibling routes remain visible; all six heterogeneous metric examples render naturally without conversion; one shared pool is shown once with affected routes and no fabricated model spend.

- [ ] **Step 7: Audit the Hermes parity checklist from §50 and visual acceptance failures from §49.**

Use the second screenshot set, not tests alone. Verify compact picker, model editor, Accounts, API Keys, Custom Endpoints, CMM offer/quota/promo improvements, and that none of the §49 failure conditions remain.

- [ ] **Step 8: Confirm worktree hygiene and commit only generic product fixes.**

Run: `git status --short && git diff --cached --check`

`.superpowers/`, public visual review screenshots, personal config, credentials, and real snapshots must remain uncommitted/ignored. If Task 12 required code fixes, commit them coherently after all gates pass.

---

## Plan self-review

- Spec coverage: Tasks 1–5 implement ProviderDirectory, route-scoped visibility, presentation catalog, safe catalog API, secure connection management, provider failure/disconnect behavior, and CMMChat-safe reuse. Tasks 6–10 implement native contracts and every required product surface. Task 11 implements the mandatory screenshot loop and accessibility pass. Task 12 maps directly to §49, §50, §53, and §53.1.
- Security: catalog reads and connection mutation remain separately authorized; secrets are stored through an injectable secure writer and never returned to normal DTOs.
- Accounting invariants: hidden routes remain in canonical Usage accounting; shared pools and supplemental balances remain semantically distinct; provider-native metrics are not coerced.
- Visual acceptance: the plan explicitly requires first-pass screenshots, recorded weaknesses, at least one code iteration, second-pass screenshots, and Hermes-side comparison before completion.
- No placeholder work remains in this plan; each task names concrete files, interfaces, RED/GREEN commands, and a coherent commit.
