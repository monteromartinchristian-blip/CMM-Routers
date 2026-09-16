# CMM Usage Router Authority Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CMM Routers the sole writable authority for provider connections, operational identities, access routes, and route visibility while preserving CMM Usage as the quota/history/observability intelligence layer and preserving the current Usage product workflows through delegation.

**Architecture:** The implementation proceeds from the Router boundary outward. First, the shared catalog gains exact-route visibility mutation, persisted administrative state, and a Router-owned administration service/API. Then CMM Usage is converted from a parallel source of operational truth into an enrichment layer over the Router catalog projection. Compatibility Usage mutation endpoints delegate to Router administration during migration, after which legacy Usage-owned visibility/connection authority and custom-route fabrication are removed from production paths without deleting historical Usage data.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, Vitest, SQLite, macOS Keychain-backed credential references, Swift Package Manager for the native CMM Usage client.

**Spec:** `docs/superpowers/specs/2026-09-16-cmm-usage-router-authority-migration-design.md`

## Global Constraints

- `CMM Routers owns connectivity and execution. CMM Usage owns observability.`
- `Visibility != connection != collection != accounting`.
- Router-owned operational state includes provider/account/product identity, provider connections, secure credential references, model identities, access routes, capabilities, routability, and route visibility.
- CMM Usage owns usage/cost events, quota graph/snapshots, balances, resets, subscription periods, history, forecasts, alerts, provenance, confidence, freshness, and FREE/PROMO/INCLUDED/TRIAL/PAYG intelligence.
- CMM Usage must not create or mutate canonical operational provider/account/product/model/route identity after migration.
- Route visibility applies to `AccessRoute`, not `ModelIdentity`; hiding one route must not hide sibling routes.
- Hiding a route must not disconnect it, stop Usage collection, erase accounting history, or alter routability.
- Execution and observability authorization remain separate explicit bindings even when they reference the same secure secret.
- Raw credentials must never be written to tracked config, Usage SQLite, logs, diagnostics, catalog projections, or presentation models.
- `NORMAL` mode contains only real state. Synthetic fixtures are allowed only in explicit Demo/Preview/test contexts and must not contaminate normal Router state.
- Historical Usage observations must remain queryable after a Router route is hidden, disconnected, or removed.
- Compatibility endpoints may exist temporarily but must delegate to Router authority; there must never be two independently writable implementations.
- No push/merge is performed unless explicitly requested by the user.
- Preserve the user's existing 20 untracked `.superpowers` paths unless a later task explicitly scopes one of them in.
- Every behavior change follows red → green TDD and ends with an independently reviewable commit.
- Before migration closure, run complete serial Node tests, publication verification, Swift tests, Swift contract, Swift release build, `git diff --check`, and worktree cleanliness verification.

---

## File Structure Map

### Router authority

- `src/catalog/types.ts` — canonical operational identity and route types.
- `src/catalog/route-visibility-policy.ts` — resolves Router-owned visibility for one exact route.
- `src/catalog/route-catalog.ts` — canonical mutable route catalog; gains exact-route visibility mutation.
- `src/catalog/provider-connections.ts` — canonical connection lifecycle; gains explicit enable/remove lifecycle primitives.
- `src/catalog/credential-bindings.ts` — execution/observability authorization bindings.
- `src/catalog/secure-credential-writer.ts` — new Router-owned secure write/remove interface.
- `src/catalog/local-secure-credential-writer.ts` — new Keychain-backed production writer implementation.
- `src/catalog/router-admin-config-store.ts` — new atomic persistence boundary for Router administrative state in `config/shared.json`.
- `src/catalog/router-administration-service.ts` — new orchestration service for connection/custom-endpoint/visibility mutations.
- `src/config/schema.ts` — persisted Router administrative schema, exact-route visibility, legacy compatibility parsing.
- `src/http/catalog.ts` — canonical safe catalog reads plus Router-owned administrative mutation endpoints.
- `src/http/server.ts` — management authentication and Router administration registration.
- `src/index.ts` — production composition of Router administration and Usage delegation.

### Usage enrichment/delegation

- `src/usage/presentation/presentation-catalog-service.ts` — becomes Router projection + Usage intelligence.
- `src/usage/presentation/provider-directory.ts` — removed from production authority; retained only if needed as presentation metadata helper.
- `src/usage/presentation/visibility-store.ts` — becomes legacy migration reader only, then leaves production effective-visibility path.
- `src/usage/service/connection-management-service.ts` — becomes a compatibility delegate to Router administration, then is no longer an authority.
- `src/usage/runtime/integration-catalog.ts` — stops fabricating operational custom provider/account/product/route IDs.
- `src/usage/runtime/production-runtime.ts` — receives Router projection/admin dependencies instead of constructing parallel operational authority.
- `src/usage/api/catalog-routes.ts` — returns Usage-enriched Router truth.
- `src/usage/api/connection-routes.ts` — compatibility HTTP surface delegating to Router administration.
- `src/usage/api/connection-auth.ts` — compatibility auth classification only while delegation exists.
- `src/usage/runtime/managed-config-store.ts` — retained only for Usage collector configuration, not Router authority.
- `src/usage/storage/schema/003_catalog_visibility.sql` — legacy storage retained until migration is proven; no new effective visibility writes.

### Tests

- `tests/catalog/route-catalog.test.ts`
- `tests/catalog/provider-connections.test.ts`
- `tests/catalog/router-admin-config-store.test.ts` — new.
- `tests/catalog/router-administration-service.test.ts` — new.
- `tests/http/router-administration.test.ts` — new.
- `tests/http/management-catalog.test.ts`
- `tests/integration/catalog-usage-boundary.test.ts`
- `tests/integration/catalog-provider-wave.test.ts`
- `tests/usage/presentation/presentation-catalog-service.test.ts`
- `tests/usage/api/catalog-routes.test.ts`
- `tests/usage/api/connection-routes.test.ts`
- `tests/usage/integration/router-authority-delegation.test.ts` — new.
- `tests/usage/integration/legacy-visibility-migration.test.ts` — new.
- `tests/usage/runtime/configured-runtime.test.ts`
- `tests/usage/runtime/production-runtime.test.ts`
- `tests/usage/runtime/public-safe-demo-fixture.test.ts`
- `tests/http/production-composition.test.ts`
- `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/**` — update only where API contract changes require it.

---

### Task 1: Make Route Visibility Exact-Route Router State

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/catalog/route-visibility-policy.ts`
- Modify: `src/catalog/route-catalog.ts`
- Modify: `src/catalog/catalog-reconciler.ts`
- Modify: `tests/catalog/route-catalog.test.ts`
- Modify: `tests/integration/catalog-provider-wave.test.ts`
- Modify: `tests/integration/catalog-usage-boundary.test.ts`
- Test: `tests/catalog/route-visibility-policy.test.ts` (create if no dedicated file exists)

**Interfaces:**
- Consumes: `AccessRoute.routeId`, `RouteSurface`, `buildRouteId(...)`, current `SharedConfig["routeVisibility"]`.
- Produces:
  - `RouteVisibilityPolicy.resolve(input: { routeId: string; providerId: string; providerModelId: string; toolCapable: boolean; exactRouteExecutable: boolean }): RouteVisibility`
  - `RouteCatalog.setVisibility(routeId: string, visibleOn: readonly RouteSurface[]): AccessRoute`
  - persisted new visibility rule shape `{ routeId: string; visibleOn: RouteSurface[] }`
  - legacy provider/model visibility rules accepted only as migration input, never emitted by new writes.

- [ ] **Step 1: Write failing exact-route visibility tests**

Add tests that create two routes with the same provider/model but different connection IDs and prove hiding route A leaves route B unchanged:

```ts
it("mutates visibility for exactly one route and leaves siblings untouched", () => {
  const state = createCatalogWithSiblingRoutes();
  const [routeA, routeB] = state.routeCatalog.list();

  state.routeCatalog.setVisibility(routeA.routeId, ["admin_console"]);

  expect(state.routeCatalog.get(routeA.routeId)?.visibility.visibleOn)
    .toEqual(["admin_console"]);
  expect(state.routeCatalog.get(routeB.routeId)?.visibility.visibleOn)
    .toContain("cmmchat_model_picker");
  expect(state.routeCatalog.get(routeA.routeId)?.routable).toBe(true);
  expect(state.routeCatalog.get(routeB.routeId)?.routable).toBe(true);
});
```

Add a policy test proving an exact `routeId` rule takes precedence and that a legacy provider/model rule does not broaden visibility when it maps ambiguously to multiple routes.

- [ ] **Step 2: Run targeted tests and confirm RED**

Run:

```bash
npx --no-install vitest run \
  tests/catalog/route-catalog.test.ts \
  tests/integration/catalog-provider-wave.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because `RouteCatalog.setVisibility` and exact-route persisted visibility are not implemented.

- [ ] **Step 3: Extend the shared config visibility schema**

Change the canonical writable shape to exact route IDs:

```ts
const routeVisibilityRuleSchema = z.object({
  routeId: z.string().min(1),
  visibleOn: z.array(routeSurfaceSchema),
}).strict();
```

Keep a legacy parser for the existing `{ providerId, providerModelId, visibleOn }` shape only so startup can classify/migrate old config. New serialization must emit only `routeId`.

Export a small normalized type:

```ts
export interface ExactRouteVisibilityRule {
  routeId: string;
  visibleOn: RouteSurface[];
}
```

- [ ] **Step 4: Implement exact-route visibility mutation**

Add to `RouteCatalog`:

```ts
setVisibility(routeId: string, visibleOn: readonly RouteSurface[]): AccessRoute {
  const route = this.routes.get(routeId);
  if (route === undefined) throw new Error(`Unknown route: ${routeId}`);

  const next = snapshotRoute({
    ...route,
    visibility: { visibleOn: [...visibleOn] },
  });
  this.routes.set(routeId, next);
  return snapshotRoute(next);
}
```

Do not mutate `routable`, connection state, model identity, or sibling routes.

Update `RouteVisibilityPolicy` to accept `routeId` and resolve exact-route rules. Update `CatalogReconciler` to compute the route ID before asking the policy for visibility.

- [ ] **Step 5: Run targeted tests and confirm GREEN**

Run the same Vitest command from Step 2.

Expected: PASS; sibling visibility and routability assertions remain independent.

- [ ] **Step 6: Run type/build gate**

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add \
  src/config/schema.ts \
  src/catalog/route-visibility-policy.ts \
  src/catalog/route-catalog.ts \
  src/catalog/catalog-reconciler.ts \
  tests/catalog/route-catalog.test.ts \
  tests/integration/catalog-provider-wave.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  tests/catalog/route-visibility-policy.test.ts
git commit -m "fix(catalog): make route visibility exact-route state"
```

---

### Task 2: Add Router-Owned Persistent Administration State and Secure Credential Writing

**Files:**
- Create: `src/catalog/secure-credential-writer.ts`
- Create: `src/catalog/local-secure-credential-writer.ts`
- Create: `src/catalog/router-admin-config-store.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/usage/runtime/credential-writer.ts` to re-export/adapter the shared interface during compatibility.
- Test: `tests/catalog/router-admin-config-store.test.ts`
- Modify: `tests/config/load-config.test.ts`
- Modify: `tests/security/log-hygiene.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SecureCredentialWriteResult {
  secretRef: string;
  hint?: string;
}

export interface SecureCredentialWriter {
  write(bindingId: string, secret: string): Promise<SecureCredentialWriteResult>;
  remove(secretRef: string): Promise<void>;
}

export class RouterAdminConfigStore {
  constructor(configDir?: string);
  read(): SharedConfig;
  write(config: SharedConfig): Promise<void>;
  update(mutate: (current: SharedConfig) => SharedConfig): Promise<SharedConfig>;
}
```

- Canonical persisted admin state uses secure refs only.

- [ ] **Step 1: Write failing persistence/security tests**

Create tests that prove:
1. `RouterAdminConfigStore.update()` writes atomically to `shared.json`.
2. parsing rejects raw fields named `apiKey`, `accessToken`, `secret`, `cookie`, or equivalent credential values in Router admin entries.
3. written config contains only `secretRef`.
4. a failed validation leaves the previous `shared.json` byte-for-byte unchanged.

Representative test:

```ts
it("persists secure references without raw credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmm-router-admin-"));
  const store = new RouterAdminConfigStore(dir);

  const next = await store.update((config) => ({
    ...config,
    administrativeConnections: [{
      connectionId: "connection:openrouter:primary",
      providerId: "openrouter",
      connectionKind: "openai-chat-completions",
      executionSecretRef: "keychain://CMM%20Routers/openrouter-primary",
      enabled: true,
    }],
  }));

  expect(JSON.stringify(next)).toContain("keychain://");
  expect(JSON.stringify(next)).not.toContain("raw-secret-value");
});
```

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/catalog/router-admin-config-store.test.ts \
  tests/config/load-config.test.ts \
  tests/security/log-hygiene.test.ts \
  --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because the store and shared writer do not exist.

- [ ] **Step 3: Add shared secure credential writer**

Move the generic contract out of Usage ownership. Keep the current Keychain behavior but change its canonical module to `src/catalog/local-secure-credential-writer.ts`. The Usage compatibility module may re-export the new interface/implementation so existing imports remain green during migration:

```ts
export {
  LocalSecureCredentialWriter,
  type SecureCredentialWriter as CredentialWriter,
} from "../../catalog/local-secure-credential-writer.js";
```

Do not alter Keychain service/account semantics in this task unless a test proves they are currently Usage-branded in a way that prevents Router ownership; if so, add backwards-compatible lookup before changing storage.

- [ ] **Step 4: Implement atomic Router admin config persistence**

`RouterAdminConfigStore.write()` must:
1. validate via the shared config parser;
2. create the config directory;
3. write `${path}.tmp` mode `0600`;
4. rename atomically to `shared.json`.

Use the same fail-closed pattern already proven by `ManagedConfigStore`, but on Router `shared.json`.

- [ ] **Step 5: Extend shared schema with administrative connection records**

Add only the fields needed by Router authority:

```ts
{
  connectionId,
  providerId,
  accountId?,
  productId?,
  connectionKind,
  executionSecretRef?,
  observabilitySecretRef?,
  profileRef?,
  endpointRef?,
  enabled
}
```

Do not serialize raw secrets.

- [ ] **Step 6: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/catalog/router-admin-config-store.test.ts \
  tests/config/load-config.test.ts \
  tests/security/log-hygiene.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add \
  src/catalog/secure-credential-writer.ts \
  src/catalog/local-secure-credential-writer.ts \
  src/catalog/router-admin-config-store.ts \
  src/config/schema.ts \
  src/usage/runtime/credential-writer.ts \
  tests/catalog/router-admin-config-store.test.ts \
  tests/config/load-config.test.ts \
  tests/security/log-hygiene.test.ts
git commit -m "feat(catalog): persist router administrative state"
```

---

### Task 3: Build `RouterAdministrationService`

**Files:**
- Create: `src/catalog/router-administration-service.ts`
- Modify: `src/catalog/provider-connections.ts`
- Modify: `src/catalog/credential-bindings.ts`
- Modify: `src/catalog/catalog-reconciler.ts`
- Test: `tests/catalog/router-administration-service.test.ts`
- Modify: `tests/catalog/provider-connections.test.ts`
- Modify: `tests/integration/catalog-usage-boundary.test.ts`

**Interfaces:**
- Consumes:
  - `ProviderDirectory`
  - `ProviderConnectionService`
  - `CredentialBindingStore`
  - `RouteCatalog`
  - `CatalogReconciler`
  - `RouterAdminConfigStore`
  - `SecureCredentialWriter`
- Produces:

```ts
export interface ConnectProviderInput {
  providerId: string;
  connectionId: string;
  connectionKind: ConnectionKind;
  secret?: string;
  accountId?: string;
  productId?: string;
  profileRef?: string;
  endpointRef?: string;
  authorizeExecution: boolean;
  authorizeObservability: boolean;
}

export interface AddCustomEndpointInput {
  connectionId: string;
  displayName: string;
  endpointUrl: string;
  apiKey?: string;
  defaultModel?: string;
  visibleOn?: RouteSurface[];
}

export class RouterAdministrationService {
  connect(input: ConnectProviderInput): Promise<SafeConnectionSummary>;
  disconnect(connectionId: string): Promise<void>;
  setEnabled(connectionId: string, enabled: boolean): Promise<SafeConnectionSummary>;
  validate(connectionId: string): Promise<SafeConnectionSummary>;
  refreshModels(connectionId: string): Promise<ConnectionReconcileResult>;
  addCustomEndpoint(input: AddCustomEndpointInput): Promise<SafeConnectionSummary>;
  setRouteVisibility(routeId: string, visibleOn: readonly RouteSurface[]): Promise<AccessRoute>;
}
```

- [ ] **Step 1: Write RED service tests**

Cover:
- unknown provider fails without persistence;
- unsupported connection kind fails without persistence;
- successful connection stores secret securely and persists only refs;
- execution and observability bindings are independently created;
- removing observability leaves execution valid;
- disconnect removes Router connection authority but not unrelated Usage data;
- hiding one route changes only that route;
- custom endpoint receives Router-generated canonical identity and route state;
- credential writer rollback occurs if persistence/service setup fails.

Representative independent-binding assertion:

```ts
expect(bindings.getExecution("execution:openrouter-primary")).toMatchObject({
  purpose: "execution",
});
expect(bindings.getObservability("observability:openrouter-primary")).toMatchObject({
  purpose: "observability",
});
```

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/catalog/router-administration-service.test.ts \
  tests/catalog/provider-connections.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because service/lifecycle methods are missing.

- [ ] **Step 3: Add explicit connection lifecycle primitives**

Extend `ProviderConnectionService` with:

```ts
enable(connectionId: string): ProviderConnection
remove(connectionId: string): ProviderConnection | undefined
```

`enable` changes only connection status. `remove` removes only the connection. Neither method deletes Usage history.

Add any needed binding remove/list helpers only if they are not already present.

- [ ] **Step 4: Implement service connect/disconnect with rollback**

Implementation order for `connect()`:
1. validate provider and connection kind;
2. store raw credential in secure writer if supplied;
3. create explicit execution/observability bindings according to input booleans;
4. add canonical connection;
5. persist Router admin config;
6. reconcile models;
7. on failure, roll back only state created by this operation and remove newly written secret.

Never infer observability permission from execution permission or vice versa.

- [ ] **Step 5: Implement exact route visibility mutation**

`setRouteVisibility()` must call `RouteCatalog.setVisibility()` and persist the exact route rule. It must not change `routable` or connection state.

- [ ] **Step 6: Implement custom endpoint creation**

Use Router canonical identity/connection machinery. Do not use `provider:custom:*` or `route:custom:*` strings from Usage. Use existing stable ID builders in `src/catalog/ids.ts`; if a new builder is needed, add it there with tests rather than hand-assembling IDs.

- [ ] **Step 7: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/catalog/router-administration-service.test.ts \
  tests/catalog/provider-connections.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 8: Commit**

```bash
git add \
  src/catalog/router-administration-service.ts \
  src/catalog/provider-connections.ts \
  src/catalog/credential-bindings.ts \
  src/catalog/catalog-reconciler.ts \
  tests/catalog/router-administration-service.test.ts \
  tests/catalog/provider-connections.test.ts \
  tests/integration/catalog-usage-boundary.test.ts
git commit -m "feat(catalog): add router administration service"
```

---

### Task 4: Expose Router-Owned Administration HTTP API

**Files:**
- Modify: `src/http/catalog.ts`
- Modify: `src/http/server.ts`
- Modify: `src/index.ts`
- Create: `tests/http/router-administration.test.ts`
- Modify: `tests/http/management-catalog.test.ts`
- Modify: `tests/http/production-composition.test.ts`

**Interfaces:**
- Consumes: `RouterAdministrationService`.
- Produces Router-owned privileged endpoints under `/v1/cmm/catalog/**`:

```text
POST   /v1/cmm/catalog/connections
PATCH  /v1/cmm/catalog/connections/:connectionId
DELETE /v1/cmm/catalog/connections/:connectionId
POST   /v1/cmm/catalog/connections/:connectionId/validate
POST   /v1/cmm/catalog/connections/:connectionId/refresh
POST   /v1/cmm/catalog/custom-endpoints
PATCH  /v1/cmm/catalog/routes/:routeId/visibility
```

`GET /v1/cmm/catalog` remains unchanged as the safe canonical projection.

- [ ] **Step 1: Write RED HTTP tests**

Prove:
- read bearer can GET but receives 401/403 on mutations;
- management bearer can mutate;
- raw request secret is never echoed;
- response contains no `secretRef`;
- unsupported provider/kind yields 4xx with no state mutation;
- visibility PATCH changes exact route only;
- all other mutation verbs on base `/v1/cmm/catalog` remain 404.

Representative test:

```ts
const response = await server.inject({
  method: "PATCH",
  url: `/v1/cmm/catalog/routes/${encodeURIComponent(routeA.routeId)}/visibility`,
  headers: managementAuth,
  payload: { visibleOn: ["admin_console"] },
});
expect(response.statusCode).toBe(200);
expect(response.body).not.toMatch(/secret|keychain/i);
expect(state.routeCatalog.get(routeB.routeId)?.visibility.visibleOn)
  .toContain("cmmchat_model_picker");
```

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/http/router-administration.test.ts \
  tests/http/management-catalog.test.ts \
  tests/http/production-composition.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Add management auth at Router surface**

Reuse existing management bearer verification mechanics, but stop describing the credential as scoped to Usage mutation. The privileged credential now authorizes Router administrative mutation.

Keep read-only catalog authentication separate from privileged mutation authentication.

- [ ] **Step 4: Register Router administration handlers**

Validate request bodies with Zod. Handlers call only `RouterAdministrationService`. They do not call `VisibilityStore`, `ConnectionManagementService`, or write Usage SQLite.

Responses use safe summaries/projections.

- [ ] **Step 5: Wire production composition**

`createProductionRegistry()` / `createProductionServer()` must expose/inject the Router administration service constructed from the same canonical `ProviderDirectory`, `ProviderConnectionService`, `CredentialBindingStore`, `RouteCatalog`, and `CatalogReconciler` used by execution.

No second Router state graph is allowed.

- [ ] **Step 6: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/http/router-administration.test.ts \
  tests/http/management-catalog.test.ts \
  tests/http/production-composition.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add \
  src/http/catalog.ts \
  src/http/server.ts \
  src/index.ts \
  tests/http/router-administration.test.ts \
  tests/http/management-catalog.test.ts \
  tests/http/production-composition.test.ts
git commit -m "feat(http): expose router administration API"
```

---

### Task 5: Convert Usage Presentation to `Router Truth + Usage Intelligence`

**Files:**
- Modify: `src/usage/presentation/presentation-catalog-service.ts`
- Modify: `src/usage/presentation/types.ts`
- Modify: `src/usage/api/catalog-routes.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `tests/usage/presentation/presentation-catalog-service.test.ts`
- Modify: `tests/usage/api/catalog-routes.test.ts`
- Create: `tests/usage/integration/router-authority-delegation.test.ts`

**Interfaces:**
- Consumes `RouterCatalogProjection` from `src/catalog/projection.ts`.
- Produces an enriched Usage presentation where Router fields are copied authoritatively and Usage-only fields are attached.

Add a source interface so production can inject current Router truth without coupling Usage to HTTP:

```ts
export interface RouterCatalogSource {
  read(): Promise<RouterCatalogProjection> | RouterCatalogProjection;
}
```

`PresentationCatalogService` constructor becomes conceptually:

```ts
constructor(
  private readonly routerCatalog: RouterCatalogSource,
  private readonly store: UsageStore,
  private readonly queries: UsageQueryService,
  options: PresentationCatalogServiceOptions = {},
)
```

- [ ] **Step 1: Write RED enrichment tests**

Create a fixture where Usage SQLite deliberately disagrees with Router state:
- Usage route says visible/available;
- Router projection says hidden/not routable;
- presentation must show Router hidden/not-routable truth;
- quota/history from Usage still appears.

Also prove a Usage-only route absent from Router is not returned as a current operational route but remains accessible through historical Usage queries.

Representative assertion:

```ts
expect(route.visibility).toEqual({ visibleOn: ["admin_console"] });
expect(route.routable).toBe(false);
expect(route.quota).toContainEqual(expect.objectContaining({
  bucketId: "bucket:openrouter:credits",
}));
```

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/api/catalog-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Refactor presentation types**

Replace Usage-owned `"visible" | "hidden"` operational visibility with Router `visibleOn` semantics in current-route views. Keep historical Usage status fields separate and explicitly named so they cannot masquerade as current Router availability.

- [ ] **Step 4: Rebuild `PresentationCatalogService.listRoutes()` around Router projection**

Algorithm:
1. read current Router projection;
2. index Usage quota/history by canonical route ID;
3. iterate Router routes only for current operational list;
4. attach Router provider/account/product/model/connection fields unchanged;
5. attach Usage quota/balance/offer/freshness/forecast fields;
6. never overwrite Router `routable`, capabilities, visibility, or identity.

`listPromotions()` continues to filter Usage offer intelligence but only across current Router routes.

- [ ] **Step 5: Change Usage catalog API reads**

`/v1/cmm/usage/catalog/providers`, `/routes`, `/routes/:id`, `/promotions`, `/quotas` now project the enriched Router-based presentation.

The old `/v1/cmm/usage/catalog/visibility` read may remain temporarily as a compatibility view, but it must report Router effective visibility, not SQLite preferences.

- [ ] **Step 6: Wire production runtime to the in-process Router catalog source**

From production composition, inject a `RouterCatalogSource` backed by `buildRouterCatalogProjection(...)` using the same canonical Router graph used by `/v1/cmm/catalog`.

Do not make Usage call its own local HTTP endpoint.

- [ ] **Step 7: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/api/catalog-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 8: Commit**

```bash
git add \
  src/usage/presentation/presentation-catalog-service.ts \
  src/usage/presentation/types.ts \
  src/usage/api/catalog-routes.ts \
  src/usage/runtime/production-runtime.ts \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/api/catalog-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts
git commit -m "refactor(usage): enrich canonical router catalog"
```

---

### Task 6: Delegate Usage Connection and Visibility Mutations to Router Administration

**Files:**
- Modify: `src/usage/service/connection-management-service.ts`
- Modify: `src/usage/api/connection-routes.ts`
- Modify: `src/usage/api/connection-auth.ts`
- Modify: `src/http/server.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `tests/usage/api/connection-routes.test.ts`
- Modify: `tests/usage/integration/router-authority-delegation.test.ts`
- Modify: `tests/http/production-composition.test.ts`

**Interfaces:**
- `ConnectionManagementService` becomes compatibility-only and consumes `RouterAdministrationService`.
- No compatibility operation writes `usage.json` for Router-owned state or writes `VisibilityStore`.

Compatibility methods keep current UI-facing names temporarily:

```ts
connectWithApiKey(...)
connectAccount(...)
addCustomEndpoint(...)
disconnect(...)
enable(...)
disable(...)
testConnection(...)
setVisibility(...)
```

but delegate operational work to Router administration.

- [ ] **Step 1: Write RED delegation tests**

Use spies/fakes to prove:
- POST `/v1/cmm/usage/connections/api-key` invokes Router admin exactly once;
- it does not call `ManagedConfigStore.update`;
- it does not call `VisibilityStore.set`;
- PATCH legacy visibility invokes `RouterAdministrationService.setRouteVisibility`;
- read-only Usage bearer cannot mutate;
- management bearer can mutate;
- response leaks no raw secret or secure ref.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  tests/http/production-composition.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Replace compatibility service internals with delegation**

Remove operational writes from `ConnectionManagementService`. Its constructor should accept `RouterAdministrationService` and, only where needed, Usage collector configuration services.

Operational methods delegate:

```ts
async disconnect(connectionId: string): Promise<void> {
  await this.routerAdmin.disconnect(connectionId);
}
```

Visibility compatibility maps the legacy `{ routeId, state }` request to exact Router surfaces. `"hidden"` becomes `["admin_console"]`; `"visible"` restores the route's safe executable surfaces using canonical Router policy/current capability, not a hard-coded tool assumption.

- [ ] **Step 4: Keep collector configuration separate**

If an action also enables a Usage collector, perform that as a separate Usage operation after Router connection success. A collector failure must not silently roll back a successfully persisted Router connection unless the API explicitly declares the entire operation transactional.

Return separate operational/observability status when both are involved.

- [ ] **Step 5: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  tests/http/production-composition.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add \
  src/usage/service/connection-management-service.ts \
  src/usage/api/connection-routes.ts \
  src/usage/api/connection-auth.ts \
  src/http/server.ts \
  src/usage/runtime/production-runtime.ts \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  tests/http/production-composition.test.ts
git commit -m "refactor(usage): delegate operational mutations to router"
```

---

### Task 7: Migrate Legacy Usage Visibility Safely

**Files:**
- Create: `src/usage/migration/legacy-visibility-migration.ts`
- Modify: `src/usage/presentation/visibility-store.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `src/usage/storage/sqlite-usage-store.ts` only for read-only migration access if current APIs are insufficient.
- Test: `tests/usage/integration/legacy-visibility-migration.test.ts`
- Modify: `tests/usage/presentation/visibility-store.test.ts`
- Modify: `tests/integration/catalog-usage-boundary.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LegacyVisibilityMigrationResult {
  migratedRouteIds: string[];
  skippedAmbiguous: string[];
  skippedUnknown: string[];
}

export async function migrateLegacyVisibility(
  legacy: Pick<VisibilityStore, "list">,
  catalog: RouterCatalogProjection,
  admin: Pick<RouterAdministrationService, "setRouteVisibility">,
): Promise<LegacyVisibilityMigrationResult>
```

- [ ] **Step 1: Write RED migration tests**

Cases:
1. exact route-scoped legacy row maps one-to-one and migrates;
2. provider/product-only row matching multiple routes is ambiguous and does not mutate;
3. unknown route does not create Router state;
4. hidden migration never broadens visibility;
5. migration is idempotent;
6. after migration, production effective visibility is read from Router even if SQLite legacy row disagrees.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/integration/legacy-visibility-migration.test.ts \
  tests/usage/presentation/visibility-store.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Implement fail-closed migration**

Only route-scoped rows with a unique current Router route may mutate Router visibility automatically.

Provider/product/workspace-scoped rows that cannot be uniquely represented in current Router semantics are reported as skipped. Do not guess or broaden.

- [ ] **Step 4: Remove `VisibilityStore` from effective presentation/runtime authority**

`VisibilityStore` remains available only to read legacy rows for migration/history during this phase. No current route rendering or mutation should depend on it.

- [ ] **Step 5: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/integration/legacy-visibility-migration.test.ts \
  tests/usage/presentation/visibility-store.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add \
  src/usage/migration/legacy-visibility-migration.ts \
  src/usage/presentation/visibility-store.ts \
  src/usage/runtime/production-runtime.ts \
  src/usage/storage/sqlite-usage-store.ts \
  tests/usage/integration/legacy-visibility-migration.test.ts \
  tests/usage/presentation/visibility-store.test.ts \
  tests/integration/catalog-usage-boundary.test.ts
git commit -m "refactor(usage): migrate legacy visibility to router"
```

---

### Task 8: Stop Usage from Fabricating Operational Identities and Routes

**Files:**
- Modify: `src/usage/runtime/integration-catalog.ts`
- Modify: `src/usage/runtime/configured-runtime.ts`
- Modify: `src/usage/domain/types.ts` only where operational identity types must be distinguished from historical observation types.
- Modify: `src/usage/service/usage-service.ts`
- Modify: `src/usage/reconciliation/reconciler.ts`
- Modify: `tests/usage/runtime/configured-runtime.test.ts`
- Modify: `tests/usage/integration/usage-service.test.ts`
- Modify: `tests/usage/reconciliation/reconciler.test.ts`
- Modify: `tests/usage/runtime/public-safe-demo-fixture.test.ts`
- Modify: `tests/usage/integration/router-authority-delegation.test.ts`

**Interfaces:**
- Usage collectors receive canonical Router identity bindings rather than constructing current operational IDs.

Add an explicit collector binding object:

```ts
export interface UsageCollectorBinding {
  integrationId: string;
  providerId: string;
  accountId?: string;
  productId?: string;
  connectionId?: string;
  routeIds: string[];
  observabilityBindingId?: string;
}
```

- [ ] **Step 1: Write RED tests proving Usage cannot invent Router state**

For a custom OpenAI-compatible collector:
- Router projection contains canonical provider/account/product/route IDs;
- Usage collector ingests observations against those IDs;
- no `provider:custom:*`, `account:custom:*`, `product:custom:*`, or `route:custom:*` operational entity is created by `integration-catalog.ts`.

Add a negative assertion:

```ts
expect(serializedUsageStore)
  .not.toMatch(/provider:custom:|account:custom:|product:custom:|route:custom:/);
```

except in explicit historical fixture data designed to test migration.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/runtime/configured-runtime.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/reconciliation/reconciler.test.ts \
  tests/usage/runtime/public-safe-demo-fixture.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Remove custom operational ID construction from `integration-catalog.ts`**

`openAiCompatibleSettings` keeps collector-only fields:

```ts
usageEndpoint?
billingEndpoint?
quotaMode
```

Remove `useInCmmChat` as a Usage-owned operational setting. CMMChat exposure comes only from Router visibility.

Remove manual operational provider/account/product/accessRoute construction from the collector factory.

- [ ] **Step 4: Bind collectors to canonical Router identities**

`ConfiguredUsageRuntime` receives `UsageCollectorBinding` records produced from Router projection/admin state and explicit observability bindings.

Collection output may create historical observation rows referencing canonical IDs, but may not register a new current operational route.

- [ ] **Step 5: Preserve demo isolation**

Update public-safe demo fixtures to provide their own isolated fake `RouterCatalogSource` and collector bindings in memory. Assert normal production composition never receives those demo identities unless `CMM_USAGE_DEMO_FIXTURE=1`.

- [ ] **Step 6: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/runtime/configured-runtime.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/reconciliation/reconciler.test.ts \
  tests/usage/runtime/public-safe-demo-fixture.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add \
  src/usage/runtime/integration-catalog.ts \
  src/usage/runtime/configured-runtime.ts \
  src/usage/domain/types.ts \
  src/usage/service/usage-service.ts \
  src/usage/reconciliation/reconciler.ts \
  tests/usage/runtime/configured-runtime.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/reconciliation/reconciler.test.ts \
  tests/usage/runtime/public-safe-demo-fixture.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts
git commit -m "refactor(usage): bind collectors to router identities"
```

---

### Task 9: Remove Production Dependence on the Parallel Usage Provider Directory and Managed Router State

**Files:**
- Modify: `src/usage/presentation/provider-directory.ts`
- Modify: `src/usage/runtime/managed-config-store.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Modify: `src/usage/service/connection-management-service.ts`
- Modify: `src/http/server.ts`
- Modify: `src/index.ts`
- Modify: `tests/usage/presentation/provider-directory.test.ts`
- Modify: `tests/usage/runtime/managed-config-store.test.ts`
- Modify: `tests/http/production-composition.test.ts`
- Modify: `tests/integration/catalog-usage-boundary.test.ts`

**Interfaces:**
- Provider connection state shown by Usage comes from Router projection.
- `ManagedConfigStore` remains only for Usage collector configuration.
- Any retained `ProviderDirectory` becomes static presentation metadata keyed by canonical Router provider ID; it no longer derives connected/disabled state from Usage integrations.

- [ ] **Step 1: Write RED no-parallel-authority tests**

Assert production composition:
- constructs exactly one canonical Router `ProviderDirectory`;
- Usage presentation provider connected/disabled status comes from Router catalog projection;
- `ConnectionManagementService` has no `ManagedConfigStore` dependency for operational connection lifecycle;
- no production effective visibility path imports `VisibilityStore`;
- `usage.json` mutation cannot create/remove a Router connection.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/presentation/provider-directory.test.ts \
  tests/usage/runtime/managed-config-store.test.ts \
  tests/http/production-composition.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Simplify provider presentation**

Keep only UI metadata not present in canonical Router provider definitions, such as friendly descriptions or Usage capability labels. Join it by Router provider ID; never use Usage integration presence as operational connection truth.

- [ ] **Step 4: Constrain `ManagedConfigStore`**

Schema/runtime writes in `usage.json` may control collector enablement, collector-specific endpoints, polling, or quota parsing settings. Remove/deprecate fields whose only purpose was Router connection, route, or CMMChat visibility ownership.

- [ ] **Step 5: Remove production imports of legacy operational authority**

Production `src/index.ts` and `src/http/server.ts` should no longer need `VisibilityStore` for current product truth and should no longer construct a Usage-owned operational connection manager except as a compatibility delegate around Router administration.

- [ ] **Step 6: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/presentation/provider-directory.test.ts \
  tests/usage/runtime/managed-config-store.test.ts \
  tests/http/production-composition.test.ts \
  tests/integration/catalog-usage-boundary.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add \
  src/usage/presentation/provider-directory.ts \
  src/usage/runtime/managed-config-store.ts \
  src/usage/runtime/production-runtime.ts \
  src/usage/service/connection-management-service.ts \
  src/http/server.ts \
  src/index.ts \
  tests/usage/presentation/provider-directory.test.ts \
  tests/usage/runtime/managed-config-store.test.ts \
  tests/http/production-composition.test.ts \
  tests/integration/catalog-usage-boundary.test.ts
git commit -m "refactor(usage): remove parallel operational authority"
```

---

### Task 10: Preserve Historical Usage When Router State Disappears

**Files:**
- Modify: `src/usage/service/usage-query-service.ts`
- Modify: `src/usage/storage/usage-store.ts`
- Modify: `src/usage/storage/sqlite-usage-store.ts`
- Modify: `src/usage/presentation/presentation-catalog-service.ts`
- Modify: `tests/usage/storage/sqlite-usage-store.test.ts`
- Modify: `tests/usage/integration/usage-service.test.ts`
- Modify: `tests/usage/presentation/presentation-catalog-service.test.ts`
- Modify: `tests/usage/integration/router-authority-delegation.test.ts`

**Interfaces:**
- Current operational route lists come from Router projection.
- Historical Usage queries may return records for retired/removed route IDs with an explicit non-current marker.

Add a historical view shape if one does not already exist:

```ts
export interface HistoricalRouteUsageView {
  routeId: string;
  currentOperationalRoute: boolean;
  usageEvents: UsageEvent[];
  costEvents: CostEvent[];
  quotaSnapshots: QuotaSnapshot[];
}
```

- [ ] **Step 1: Write RED historical-retention tests**

Scenario:
1. ingest usage/quota/cost for canonical route;
2. remove/disconnect route from Router catalog;
3. current presentation route list no longer presents it as executable;
4. historical Usage query still returns all observations;
5. disconnect does not delete rows.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/usage/storage/sqlite-usage-store.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Separate current operational projection from historical lookup**

Do not cascade-delete Usage data on Router disconnect/removal. Current route presentation iterates Router projection; historical query indexes Usage rows by stored canonical route ID independent of current presence.

- [ ] **Step 4: Run GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/usage/storage/sqlite-usage-store.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add \
  src/usage/service/usage-query-service.ts \
  src/usage/storage/usage-store.ts \
  src/usage/storage/sqlite-usage-store.ts \
  src/usage/presentation/presentation-catalog-service.ts \
  tests/usage/storage/sqlite-usage-store.test.ts \
  tests/usage/integration/usage-service.test.ts \
  tests/usage/presentation/presentation-catalog-service.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts
git commit -m "feat(usage): preserve retired route history"
```

---

### Task 11: Update Native CMM Usage Contract to the New Authority Model

**Files:**
- Modify: `apps/cmm-usage-macos/Sources/CMMUsageCore/**` only where decoded API models changed.
- Modify: `apps/cmm-usage-macos/Tests/CMMUsageCoreTests/**`
- Modify: Node API contract fixtures used by the native client.
- Test: existing `CMMUsageContractTests` executable.

**Interfaces:**
- Native client still exposes Providers, Accounts/API Keys/Custom Endpoints, catalog, quotas, promotions, and model visibility controls.
- Mutation calls target Router-owned administration endpoints directly or through the temporary compatibility surface, depending on the production API boundary at this task.
- Presentation consumes Router effective `visibleOn` and canonical route identity.

- [ ] **Step 1: Write/adjust failing Swift decoding and interaction tests**

Cover:
- exact route visibility;
- connected/degraded/available provider state from Router truth;
- quota enrichment remains present;
- no raw secret/security reference in decoded payload;
- hidden sibling routes remain independent;
- current operational route absent after disconnect while historical data remains accessible in its historical view.

- [ ] **Step 2: Run Swift RED**

```bash
swift test --package-path apps/cmm-usage-macos
swift run --package-path apps/cmm-usage-macos CMMUsageContractTests
```

Expected: at least the changed API contract tests fail before client adaptation.

- [ ] **Step 3: Adapt native models and request wiring minimally**

Do not redesign UI. Preserve current UX while updating endpoint/payload semantics. Keep all user-visible values derived from real Router/Usage state.

- [ ] **Step 4: Run Swift GREEN**

```bash
swift test --package-path apps/cmm-usage-macos
swift run --package-path apps/cmm-usage-macos CMMUsageContractTests
swift build --package-path apps/cmm-usage-macos -c release
```

Expected: all exit 0.

- [ ] **Step 5: Run relevant Node/native contract tests**

```bash
npx --no-install vitest run \
  tests/usage/api/catalog-routes.test.ts \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
git diff --check
```

- [ ] **Step 6: Commit**

Stage only actual native/API contract files changed and commit:

```bash
git commit -m "refactor(usage-macos): follow router authority contract"
```

---

### Task 12: Retire Legacy Writable Authority and Lock the Boundary

**Files:**
- Modify/remove production use of: `src/usage/presentation/visibility-store.ts`
- Modify: `src/usage/api/connection-routes.ts`
- Modify: `src/usage/api/connection-auth.ts`
- Modify: `src/usage/service/connection-management-service.ts`
- Modify: `src/usage/runtime/managed-config-store.ts`
- Modify: `src/usage/runtime/production-runtime.ts`
- Keep migration-compatible DB schema until explicit later schema cleanup unless all migration requirements are already met.
- Modify: `tests/integration/catalog-usage-boundary.test.ts`
- Modify: `tests/usage/api/connection-routes.test.ts`
- Modify: `tests/usage/integration/legacy-visibility-migration.test.ts`
- Modify: `tests/usage/integration/router-authority-delegation.test.ts`
- Add/modify architecture guard tests under `tests/integration/`.

**Interfaces:**
- After this task there is one writable authority: Router administration.
- Any retained `/v1/cmm/usage/connections/**` or `/v1/cmm/usage/catalog/visibility` endpoint must be a thin delegate with no independent state store.

- [ ] **Step 1: Write RED architecture guard tests**

Add source/behavior guards asserting:
- production Usage presentation does not import `VisibilityStore` as effective state;
- production connection mutation does not instantiate/write Router-owned `ManagedConfigStore` fields;
- `integration-catalog.ts` contains no canonical operational ID fabrication;
- Router admin is the sole target of current operational mutations;
- Usage SQLite visibility rows cannot override Router current visibility.

- [ ] **Step 2: Run RED**

```bash
npx --no-install vitest run \
  tests/integration/catalog-usage-boundary.test.ts \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/legacy-visibility-migration.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
```

- [ ] **Step 3: Remove remaining production authority paths**

Delete dead methods/imports only after the guard tests show their replacement works.

Do not drop `visibility_preferences` storage migration in this task if existing user DBs still require the table for migration/history compatibility. Schema removal is a separate future DB migration after real installations have crossed the compatibility window.

- [ ] **Step 4: Run targeted GREEN + type/build**

```bash
npx --no-install vitest run \
  tests/integration/catalog-usage-boundary.test.ts \
  tests/usage/api/connection-routes.test.ts \
  tests/usage/integration/legacy-visibility-migration.test.ts \
  tests/usage/integration/router-authority-delegation.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add -A
git diff --cached --check
git commit -m "refactor(usage): retire legacy router authority"
```

Before committing, inspect `git diff --cached --name-status` and abort if unrelated `.superpowers` paths are staged.

---

### Task 13: Full Migration Verification and Closure Ledger

**Files:**
- Create: `docs/audits/2026-09-16-cmm-usage-router-authority-migration-ledger.md`
- Modify only if a verification-proven defect requires a follow-up code commit.
- Do not push.

**Interfaces:**
- Consumes all prior tasks.
- Produces verified evidence that the approved spec completion criteria are met.

- [ ] **Step 1: Run boundary-focused suite**

```bash
npx --no-install vitest run \
  tests/catalog \
  tests/integration/catalog-usage-boundary.test.ts \
  tests/usage \
  tests/http/management-catalog.test.ts \
  tests/http/router-administration.test.ts \
  tests/http/production-composition.test.ts \
  --no-file-parallelism --maxWorkers 1
```

Expected: all non-explicitly-skipped tests pass.

- [ ] **Step 2: Run static/build checks**

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: exit 0.

- [ ] **Step 3: Run complete serial Node suite**

```bash
npm run test:serial
```

Expected: exit 0. Record exact test file/test counts rather than copying historical counts into the ledger.

- [ ] **Step 4: Run publication verification**

```bash
npx --no-install vitest run tests/publication --no-file-parallelism --maxWorkers 1 --reporter verbose
```

Expected: exit 0. If a live-auth/network-coupled provider test times out while the same exact commit passes on retry, diagnose environmental coupling before changing production code or raising timeouts.

- [ ] **Step 5: Run native gates**

```bash
swift test --package-path apps/cmm-usage-macos
swift run --package-path apps/cmm-usage-macos CMMUsageContractTests
swift build --package-path apps/cmm-usage-macos -c release
```

Expected: all exit 0.

- [ ] **Step 6: Verify ownership invariants from source and behavior**

Run source searches:

```bash
git grep -n -E 'VisibilityStore|ConnectionManagementService|provider:custom:|route:custom:' -- src/usage src/http src/index.ts
git grep -n -E 'setRouteVisibility|RouterAdministrationService' -- src
```

Interpretation:
- any remaining `VisibilityStore` occurrence must be migration/history-only, not current effective visibility;
- any remaining `ConnectionManagementService` occurrence must be compatibility delegation only;
- no production custom operational ID fabrication may remain;
- Router administration must own current mutation flow.

- [ ] **Step 7: Verify preserved local work**

```bash
git status --short
git ls-files --others --exclude-standard | LC_ALL=C sort
```

Expected:
- tracked worktree/index clean after the final code/docs commit;
- the pre-existing 20 `.superpowers` untracked paths remain present and untouched unless explicitly approved otherwise.

- [ ] **Step 8: Write closure ledger**

Record:
- exact final HEAD/tree;
- commits per task;
- exact commands and return codes;
- current Node/Swift test counts;
- publication result;
- evidence for each of the ten spec completion criteria;
- any intentionally retained legacy DB compatibility artifact and why it is not current authority;
- `PUSH=NO`.

Do not claim closure if any criterion lacks evidence.

- [ ] **Step 9: Commit ledger**

```bash
git add docs/audits/2026-09-16-cmm-usage-router-authority-migration-ledger.md
git diff --cached --check
git commit -m "docs(audit): close usage router authority migration"
```

- [ ] **Step 10: Final no-push verification**

```bash
git status --short
git log -1 --oneline
```

Expected: clean tracked worktree, preserved intended untracked paths, closure ledger at HEAD, no push performed.
