# CMM Routers Shared Core Route Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical CMM Routers shared core for real provider connections, explicit credential purposes, stable model identities, executable `AccessRoute`s, per-surface visibility, and read-only projections consumed by CMM Usage.

**Architecture:** Introduce a new `src/catalog/` shared-core layer above the existing provider adapters and `ProviderRegistry`. `AccessRoute` becomes the canonical executable identity addressed by stable `routeId`; CMMChat/CMM Code resolve a route before invoking the already-working provider adapter. CMM Usage consumes a read-only catalog projection and keeps observability credentials logically separate from execution authorization.

**Tech Stack:** TypeScript, Node.js, Vitest 5, existing CMM Routers provider adapters/registry, existing security audit and fail-closed runtime policies.

**Spec:** `docs/architecture/2026-09-15-cmm-routers-shared-core-route-catalog-design.md`

## Global Constraints

- `CMM Routers owns connectivity and execution. CMM Usage owns observability.`
- `AccessRoute` is the canonical executable unit.
- `routeId` selects provider + connection + provider model + execution profile.
- `ModelIdentity` is independent from provider route.
- Route visibility is surface-specific and is enforced server-side.
- `Visibility != connection != collection != accounting`.
- `Observability authorization != execution authorization`.
- One physical secret may be reused only through explicit independent execution and observability bindings.
- Adding a key in CMM Usage never enables CMMChat execution automatically.
- CMM Usage consumes a read-only projection of the Routers catalog.
- No silent PAYG fallback.
- No cross-provider fallback from canonical model identity.
- No raw credential values in domain objects, diagnostics, tracked config or logs.
- Model discovery is administrative; it must not send inference prompts.
- Missing discovered models become unavailable, not silently deleted.
- Uncertain model canonicalization must preserve distinct identities rather than guess.
- Preserve current provider IDs, adapters, generic OpenAI-compatible execution path, spend guards, consumer capability enforcement and existing deterministic provider tests.
- No live provider inference or live administrative network discovery unless the user explicitly authorizes it.
- Before execution begins, the provider-expansion-wave base must be clean and its deterministic closure gate must have passed under a quiet host. Do not create the implementation worktree from an unverified moving base.
- Final full-suite verification must run with CMM Usage demo/runtime and other heavy development harness workloads paused to avoid known host-resource false negatives.

---

## File Structure

The new shared core is intentionally isolated under `src/catalog/` so the existing `src/registry/provider-registry.ts` can continue to own instantiated provider adapters during migration.

### New shared-core files

- `src/catalog/types.ts` — stable domain types and enums only; no I/O.
- `src/catalog/ids.ts` — deterministic stable ID construction/validation.
- `src/catalog/provider-directory.ts` — provider definitions and adapter/discovery factory metadata.
- `src/catalog/credential-bindings.ts` — secret references plus execution/observability authorization bindings.
- `src/catalog/secure-credential-resolver.ts` — resolver interface and fail-closed in-memory test resolver; production resolution plugs into existing secure-store mechanisms later.
- `src/catalog/provider-connections.ts` — `ProviderConnection` domain object and lifecycle service.
- `src/catalog/model-identities.ts` — conservative canonical model identity store/matcher.
- `src/catalog/route-catalog.ts` — `AccessRoute` store, visibility, routability and route resolution.
- `src/catalog/projection.ts` — product-safe/read-only projections for CMMChat/CMM Usage.
- `src/catalog/runtime-bridge.ts` — bridge from `AccessRoute` resolution to the existing `ProviderRegistry`/`ProviderAdapter` runtime.

### New tests

- `tests/catalog/ids.test.ts`
- `tests/catalog/provider-directory.test.ts`
- `tests/catalog/credential-bindings.test.ts`
- `tests/catalog/provider-connections.test.ts`
- `tests/catalog/model-identities.test.ts`
- `tests/catalog/route-catalog.test.ts`
- `tests/catalog/projection.test.ts`
- `tests/catalog/runtime-bridge.test.ts`
- `tests/http/cmmchat-route-resolution.test.ts`
- `tests/integration/catalog-provider-wave.test.ts`

### Existing files expected to change

- `src/providers/manifests.ts` — project current provider manifests into `ProviderDirectory` metadata without duplicating provider truth.
- `src/registry/provider-registry.ts` — expose exact provider lookup needed by `runtime-bridge`; preserve existing model namespace behavior for legacy callers.
- `src/http/openai-chat.ts` — resolve explicit CMM route selection before invoking provider runtime while preserving legacy compatibility.
- `src/http/openai-responses.ts` — same as chat surface.
- `src/http/server.ts` — receive shared catalog/runtime bridge in composition and expose product-safe catalog route(s) if existing management surface supports it.
- `src/index.ts` — compose `ProviderDirectory`, `ProviderConnectionService`, `ModelIdentityStore`, `RouteCatalog` and runtime bridge from configured provider inventory.
- `src/core/wire.ts` — only if the canonical request type needs an optional `routeId`; do not alter existing provider wire formats.
- `tests/http/server.test.ts`
- `tests/http/openai-chat.test.ts`
- `tests/http/openai-responses.test.ts`
- `tests/http/consumer-capability.test.ts`
- `tests/providers/wave-inventory.test.ts`
- `scripts/security-audit.sh` — only if a deterministic shared-core invariant belongs in the existing authoritative security gate; no broad scan redesign.

If repository inspection at implementation time shows an existing management-catalog module on the verified base, reuse it rather than create a parallel endpoint. Do not invent a second management API.

---

### Task 1: Freeze shared catalog types and stable IDs

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/ids.ts`
- Create: `tests/catalog/ids.test.ts`

**Interfaces:**
- Produces:
  - `ProviderDefinition`
  - `Account`
  - `ProviderProduct`
  - `SecretMaterialRef`
  - `ExecutionCredentialBinding`
  - `ObservabilityCredentialBinding`
  - `ProviderConnection`
  - `ModelIdentity`
  - `AccessRoute`
  - `RouteCapabilities`
  - `RouteVisibility`
  - `RouteSurface`
  - `ConnectionStatus`
  - `buildConnectionId(input)`
  - `buildModelIdentityId(input)`
  - `buildRouteId(input)`
  - `assertStableId(value, kind)`

- [ ] **Step 1: Write the failing stable-ID tests**

Create tests asserting that IDs are deterministic for the same normalized input, differ when provider/connection/providerModelId/executionProfile differ, contain no credentials, and reject empty/unsafe segments.

Use representative assertions such as:

```ts
expect(
  buildRouteId({
    providerId: "openrouter",
    connectionId: "conn_openrouter_main",
    providerModelId: "anthropic/claude-sonnet-4",
    executionProfile: "chat-only",
  }),
).toBe(
  buildRouteId({
    providerId: "openrouter",
    connectionId: "conn_openrouter_main",
    providerModelId: "anthropic/claude-sonnet-4",
    executionProfile: "chat-only",
  }),
);
```

And prove that changing `connectionId` changes the route ID.

- [ ] **Step 2: Run the RED test**

Run:

```bash
npx vitest run tests/catalog/ids.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because `src/catalog/ids.ts` and exported types do not exist.

- [ ] **Step 3: Implement the minimal domain types**

Keep `types.ts` side-effect free. Use string unions for:

```ts
export type CredentialPurpose = "execution" | "observability";
export type ConnectionStatus =
  | "configured"
  | "validating"
  | "ready"
  | "auth_required"
  | "unavailable"
  | "disabled"
  | "error";

export type RouteSurface =
  | "cmmchat_model_picker"
  | "cmmcode_model_picker"
  | "admin_console";
```

Define `AccessRoute` with exactly:

```ts
export interface AccessRoute {
  routeId: string;
  modelIdentityId: string;
  connectionId: string;
  providerId: string;
  providerModelId: string;
  executionProfile: string;
  capabilities: RouteCapabilities;
  billingClass: string;
  routable: boolean;
  visibility: RouteVisibility;
}
```

Do not add quota, balance or usage fields.

- [ ] **Step 4: Implement deterministic IDs**

Use normalized opaque IDs derived from non-secret identity fields. The implementation must never accept raw secret material as input. Prefer a short SHA-256-derived suffix over embedding full user labels.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run tests/catalog/ids.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/types.ts src/catalog/ids.ts tests/catalog/ids.test.ts
git commit -m "feat(catalog): add shared identities and stable route ids"
```

---

### Task 2: Build ProviderDirectory from existing provider truth

**Files:**
- Create: `src/catalog/provider-directory.ts`
- Create: `tests/catalog/provider-directory.test.ts`
- Modify: `src/providers/manifests.ts`

**Interfaces:**
- Consumes: `ProviderDefinition` from Task 1.
- Produces:
  - `ProviderDirectory.register(definition)`
  - `ProviderDirectory.get(providerId)`
  - `ProviderDirectory.list()`
  - `ProviderDirectory.has(providerId)`
  - a projection function in `src/providers/manifests.ts` that maps the existing manifest inventory to provider definitions without copying secrets or billing state.

- [ ] **Step 1: Write failing tests**

Cover:
- duplicate provider IDs rejected;
- lookup of known provider succeeds;
- unknown provider returns no definition/fails via the chosen exact API;
- definitions contain no `secret`, `apiKey`, token value or quota fields;
- current wave provider IDs are represented exactly once.

Use the current provider IDs already established by the repository; do not rename `command-code`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/provider-directory.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because `ProviderDirectory` does not exist.

- [ ] **Step 3: Implement ProviderDirectory**

Use an internal `Map<string, ProviderDefinition>`. Registration must be explicit and duplicate-safe. Keep adapter factories as references/metadata only if the existing manifest types already expose them; otherwise do not broaden this task.

- [ ] **Step 4: Project existing manifests into the directory**

Add a narrow function to `src/providers/manifests.ts` that emits `ProviderDefinition[]` from the existing provider manifest set. Preserve existing IDs and manifest ownership of provider-specific metadata.

- [ ] **Step 5: Run GREEN and existing provider regression**

```bash
npx vitest run tests/catalog/provider-directory.test.ts tests/providers/provider-manifest.test.ts tests/providers/wave-inventory.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/provider-directory.ts src/providers/manifests.ts tests/catalog/provider-directory.test.ts
git commit -m "feat(catalog): add provider directory over manifests"
```

---

### Task 3: Separate physical secrets from execution and observability authorization

**Files:**
- Create: `src/catalog/credential-bindings.ts`
- Create: `src/catalog/secure-credential-resolver.ts`
- Create: `tests/catalog/credential-bindings.test.ts`

**Interfaces:**
- Consumes: `SecretMaterialRef`, `ExecutionCredentialBinding`, `ObservabilityCredentialBinding`.
- Produces:
  - `CredentialBindingStore.addExecution(binding)`
  - `CredentialBindingStore.addObservability(binding)`
  - `CredentialBindingStore.getExecution(bindingId)`
  - `CredentialBindingStore.getObservability(bindingId)`
  - `CredentialBindingStore.removeExecution(bindingId)`
  - `CredentialBindingStore.removeObservability(bindingId)`
  - `SecureCredentialResolver.resolve(secretRef)`
  - `InMemorySecureCredentialResolver` for deterministic tests only.

- [ ] **Step 1: Write RED tests for authorization separation**

Prove all of these:

```text
observability-only credential cannot satisfy execution lookup
execution-only credential does not create observability binding
same secretRef can back two explicit bindings
deleting observability binding leaves execution binding intact
deleting execution binding leaves observability binding intact
raw secret value is not stored inside either binding
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/credential-bindings.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Implement binding store and resolver interface**

The in-memory resolver is test-only infrastructure for this slice. Production secure-store wiring must reuse the repository's existing secure credential mechanisms rather than introduce a competing store.

- [ ] **Step 4: Add explicit misuse guards**

Make it impossible to pass an `ObservabilityCredentialBinding` to an execution-only lookup through the public API. Prefer separate methods/types over a `purpose` string checked late at runtime.

- [ ] **Step 5: Run GREEN plus security redaction tests**

```bash
npx vitest run tests/catalog/credential-bindings.test.ts tests/security/redaction.test.ts tests/security/log-hygiene.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/credential-bindings.ts src/catalog/secure-credential-resolver.ts tests/catalog/credential-bindings.test.ts
git commit -m "feat(catalog): separate execution and observability credentials"
```

---

### Task 4: Add ProviderConnectionService and administrative discovery contract

**Files:**
- Create: `src/catalog/provider-connections.ts`
- Create: `tests/catalog/provider-connections.test.ts`

**Interfaces:**
- Consumes:
  - `ProviderDirectory`
  - `CredentialBindingStore`
  - `SecureCredentialResolver`
  - existing provider-specific discovery entry points.
- Produces:
  - `ProviderConnectionService.add(connection)`
  - `ProviderConnectionService.disable(connectionId)`
  - `ProviderConnectionService.get(connectionId)`
  - `ProviderConnectionService.list()`
  - `ProviderConnectionService.validateExecution(connectionId)`
  - `ProviderConnectionService.discoverModels(connectionId)`
  - `DiscoveredProviderModel`

Define discovery evidence as:

```ts
export interface DiscoveredProviderModel {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  displayName?: string;
  capabilities?: Partial<RouteCapabilities>;
}
```

- [ ] **Step 1: Write RED tests**

Cover:
- connection can exist without execution credential but is not execution-ready;
- observability binding cannot satisfy `validateExecution`;
- disabled connection is non-routable;
- missing/unknown provider fails closed;
- discovery is invoked only against the specified connection;
- discovery returns provider-native model IDs unchanged;
- one connection's failure does not mutate another connection.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/provider-connections.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Implement connection lifecycle**

Do not add quotas/balances. Status transitions must remain within the `ConnectionStatus` union.

- [ ] **Step 4: Implement administrative discovery adapter hook**

Reuse provider discovery already present in adapters/manifests. No generation request may be used as discovery fallback.

- [ ] **Step 5: Run GREEN and discovery regressions**

```bash
npx vitest run tests/catalog/provider-connections.test.ts tests/providers/openai-compatible-discovery.test.ts tests/providers/claude-model-discovery.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/provider-connections.ts tests/catalog/provider-connections.test.ts
git commit -m "feat(catalog): add provider connection lifecycle"
```

---

### Task 5: Canonicalize model identity conservatively

**Files:**
- Create: `src/catalog/model-identities.ts`
- Create: `tests/catalog/model-identities.test.ts`

**Interfaces:**
- Consumes: `DiscoveredProviderModel`.
- Produces:
  - `ModelIdentityStore.upsertExplicit(identity)`
  - `ModelIdentityStore.bindProviderModel(binding)`
  - `ModelIdentityStore.resolveProviderModel(providerId, connectionId, providerModelId)`
  - `ModelIdentityStore.list()`
  - `ProviderModelIdentityBinding`

Use exact binding shape:

```ts
export interface ProviderModelIdentityBinding {
  providerId: string;
  connectionId: string;
  providerModelId: string;
  modelIdentityId: string;
}
```

- [ ] **Step 1: Write RED tests**

Prove:
- explicit bindings resolve the same canonical model across multiple providers;
- same provider-native model ID on two different connections remains distinguishable;
- an unknown model gets a distinct stable identity rather than being guessed into an existing family;
- rediscovery preserves the same binding;
- removing a model from discovery marks availability elsewhere later; it does not delete identity history in this store.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/model-identities.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Implement explicit-first identity mapping**

Do not introduce fuzzy string matching in this slice. Accept explicit aliases/mappings and otherwise create a distinct deterministic identity from provider evidence.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/catalog/model-identities.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/model-identities.ts tests/catalog/model-identities.test.ts
git commit -m "feat(catalog): add conservative model identities"
```

---

### Task 6: Build RouteCatalog, routability and surface visibility

**Files:**
- Create: `src/catalog/route-catalog.ts`
- Create: `tests/catalog/route-catalog.test.ts`

**Interfaces:**
- Consumes:
  - `ProviderConnectionService`
  - `ModelIdentityStore`
  - stable ID helpers.
- Produces:
  - `RouteCatalog.upsert(route)`
  - `RouteCatalog.get(routeId)`
  - `RouteCatalog.list()`
  - `RouteCatalog.listVisible(surface)`
  - `RouteCatalog.resolveForConsumer(routeId, surface)`
  - `RouteCatalog.markUnavailable(connectionId, providerModelId)`

- [ ] **Step 1: Write RED tests**

Cover:
- one `ModelIdentity` can have multiple routes;
- each route ID differs by connection/provider-native model/execution profile;
- hidden route is still present in `list()` but absent from `listVisible("cmmchat_model_picker")`;
- manually supplying a hidden route to `resolveForConsumer` fails closed;
- a disabled/non-ready connection cannot resolve as routable;
- CHAT_ONLY route truth remains route-specific;
- no route automatically falls back to another route with the same `modelIdentityId`;
- provider model disappearing from discovery makes the route unavailable without deleting it.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Implement RouteCatalog**

Keep visibility and routability separate fields/decisions. `resolveForConsumer` must enforce both.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/route-catalog.ts tests/catalog/route-catalog.test.ts
git commit -m "feat(catalog): add executable route catalog"
```

---

### Task 7: Expose read-only product projections without leaking secrets

**Files:**
- Create: `src/catalog/projection.ts`
- Create: `tests/catalog/projection.test.ts`

**Interfaces:**
- Consumes: directory, accounts/products, connections, model identities, route catalog.
- Produces:
  - `buildRouterCatalogProjection(input): RouterCatalogProjection`
  - `buildCmmChatRouteProjection(catalog): CmmChatRouteProjection[]`

- [ ] **Step 1: Write RED projection tests**

Prove:
- projection includes stable IDs and labels required by CMM Usage;
- no `secretRef`, raw secret, profile path or provider-native auth blob appears;
- CMM Usage projection contains hidden routes because visibility does not control collection;
- CMMChat projection contains only `cmmchat_model_picker` routes;
- fixtures/demo identities are absent unless explicitly supplied by a demo-only caller.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/projection.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Implement projections**

Use explicit DTOs rather than object spreading domain objects. This prevents future secret fields from leaking automatically.

- [ ] **Step 4: Run GREEN plus redaction checks**

```bash
npx vitest run tests/catalog/projection.test.ts tests/security/redaction.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/projection.ts tests/catalog/projection.test.ts
git commit -m "feat(catalog): add safe catalog projections"
```

---

### Task 8: Bridge AccessRoute to the existing ProviderRegistry runtime

**Files:**
- Create: `src/catalog/runtime-bridge.ts`
- Create: `tests/catalog/runtime-bridge.test.ts`
- Modify: `src/registry/provider-registry.ts`

**Interfaces:**
- Consumes:
  - `RouteCatalog.resolveForConsumer(...)`
  - `ProviderConnectionService.validateExecution(...)`
  - existing `ProviderRegistry`
  - existing `ProviderAdapter`.
- Produces:
  - `CatalogRuntimeBridge.resolve(routeId, consumerSurface)`
  - exact result:

```ts
export interface ResolvedExecutionRoute {
  route: AccessRoute;
  connection: ProviderConnection;
  adapter: ProviderAdapter;
  providerModelId: string;
}
```

- [ ] **Step 1: Write RED bridge tests**

Prove:
- route resolves the exact provider adapter and provider-native model;
- no provider is inferred from display/canonical model name;
- hidden/non-routable route fails before adapter invocation;
- missing execution binding fails before adapter invocation;
- no fallback to another route;
- existing `ProviderRegistry.resolve(modelId)` legacy behavior remains unchanged for current tests.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/catalog/runtime-bridge.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL.

- [ ] **Step 3: Add exact provider lookup to ProviderRegistry if required**

Prefer a minimal method such as:

```ts
getProvider(providerId: string): ProviderAdapter | undefined
```

Do not replace `resolve(modelId)` yet.

- [ ] **Step 4: Implement CatalogRuntimeBridge**

The bridge must resolve catalog truth first and only then obtain the adapter.

- [ ] **Step 5: Run GREEN plus registry regressions**

```bash
npx vitest run tests/catalog/runtime-bridge.test.ts tests/registry/provider-registry.test.ts tests/providers/wave-inventory.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/runtime-bridge.ts src/registry/provider-registry.ts tests/catalog/runtime-bridge.test.ts
git commit -m "feat(catalog): bridge routes to provider runtime"
```

---

### Task 9: Compose the real provider wave into the shared catalog

**Files:**
- Modify: `src/index.ts`
- Modify: `src/providers/manifests.ts`
- Create: `tests/integration/catalog-provider-wave.test.ts`
- Modify: `tests/providers/wave-inventory.test.ts`

**Interfaces:**
- Consumes all shared-core services from Tasks 1–8.
- Produces one production composition that contains:
  - real provider definitions;
  - configured real connections;
  - discovered/static provider model evidence already supported by current adapters;
  - stable model identities;
  - access routes;
  - no CMM Usage fixture dependency.

- [ ] **Step 1: Write RED integration test**

The test must build production composition from deterministic fixtures/config and assert:

```text
existing three subscription bridges still present
current provider wave IDs still present
Qwen Token Plan and Qwen Cloud remain distinct connections/products
Command Code remains command-code
NVIDIA NIM activation remains Kimi K3-only
Kira/Vikey capability truth remains unchanged
no Usage fixture provider/model is required
one ModelIdentity may receive multiple explicit AccessRoutes
```

Do not make live network calls.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/integration/catalog-provider-wave.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because production composition does not yet build the catalog.

- [ ] **Step 3: Compose shared catalog in `src/index.ts`**

Reuse the same provider inventory that production already registers. Do not create a second provider list.

- [ ] **Step 4: Populate deterministic routes**

For providers whose model discovery is live-only, use the existing deterministic manifest/fixture model evidence in tests. Production may refresh administratively later; tests must stay network-free.

- [ ] **Step 5: Run GREEN plus wave regressions**

```bash
npx vitest run tests/integration/catalog-provider-wave.test.ts tests/providers/wave-inventory.test.ts tests/http/production-composition.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/providers/manifests.ts tests/integration/catalog-provider-wave.test.ts tests/providers/wave-inventory.test.ts
git commit -m "feat(catalog): compose provider wave into route catalog"
```

---

### Task 10: Add CMMChat route selection without breaking legacy OpenAI-compatible clients

**Files:**
- Modify: `src/core/wire.ts` only if needed for an internal canonical `routeId`.
- Modify: `src/http/openai-chat.ts`
- Modify: `src/http/openai-responses.ts`
- Modify: `src/http/server.ts`
- Create: `tests/http/cmmchat-route-resolution.test.ts`
- Modify: `tests/http/openai-chat.test.ts`
- Modify: `tests/http/openai-responses.test.ts`
- Modify: `tests/http/consumer-capability.test.ts`

**Interfaces:**
- Consumes: `CatalogRuntimeBridge`.
- Produces an explicit CMM route-selection path while preserving current legacy `model` namespace behavior for non-migrated clients.

- [ ] **Step 1: Inspect the verified base and choose the smallest wire-compatible route selector**

Ruling must be one of these, in order of preference:

1. If the current canonical request object can carry `routeId` without altering public OpenAI wire schemas, add it there and have a product-safe CMM endpoint populate it.
2. If an existing management/CMM-specific request surface already exists, use that exact surface.
3. If neither exists, allow an explicit route namespace in the existing `model` field (`route:<routeId>`) as a compatibility bridge.

Do **not** overload human display names or infer provider from canonical model names.

Record the chosen exact wire in the task ledger before editing.

- [ ] **Step 2: Write RED tests for CMMChat route behavior**

Prove:
- explicit route selects exact provider connection/model;
- hidden CMMChat route is rejected even when caller manually supplies its ID;
- CMMChat bearer cannot escalate to tools;
- unknown route fails closed;
- existing legacy model namespace requests continue to pass unchanged;
- no route fallback occurs.

- [ ] **Step 3: Run RED**

```bash
npx vitest run tests/http/cmmchat-route-resolution.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL because explicit catalog route resolution is not wired.

- [ ] **Step 4: Implement the narrow route path**

Resolve the explicit route before provider execution. Keep existing model-based legacy resolution untouched when no explicit route selector is used.

- [ ] **Step 5: Run focused HTTP regressions**

```bash
npx vitest run \
  tests/http/cmmchat-route-resolution.test.ts \
  tests/http/openai-chat.test.ts \
  tests/http/openai-responses.test.ts \
  tests/http/consumer-capability.test.ts \
  tests/http/chat-only-enforcement.test.ts \
  --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/wire.ts src/http/openai-chat.ts src/http/openai-responses.ts src/http/server.ts tests/http/cmmchat-route-resolution.test.ts tests/http/openai-chat.test.ts tests/http/openai-responses.test.ts tests/http/consumer-capability.test.ts
git commit -m "feat(cmmchat-router): execute explicit catalog routes"
```

If `src/core/wire.ts` was not changed, omit it from `git add`.

---

### Task 11: Add the read-only catalog surface for CMM Usage and admin consumers

**Files:**
- Modify: `src/http/server.ts`
- Reuse existing management-catalog module if present on the verified base; otherwise create `src/http/catalog.ts`.
- Create or modify: `tests/http/management-catalog.test.ts`
- Modify: `tests/catalog/projection.test.ts`

**Interfaces:**
- Consumes: `buildRouterCatalogProjection`.
- Produces a read-only management response containing provider/account/product/connection/model/route identities and zero raw credential material.

- [ ] **Step 1: Write RED management-catalog tests**

Assert:
- read-only response includes all stable identity layers;
- hidden routes remain present for Usage/admin projection;
- execution/observability binding purpose may be represented only as safe metadata if needed, never secret refs/values;
- raw secret fields/profile paths are absent;
- endpoint cannot create or mutate providers/routes;
- demo fixtures are not emitted in normal mode.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/http/management-catalog.test.ts tests/catalog/projection.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: FAIL until the shared catalog projection is exposed.

- [ ] **Step 3: Implement/reuse the read-only endpoint**

Use the repository's existing management authentication and loopback policy. Do not create a second auth system.

- [ ] **Step 4: Run GREEN and security checks**

```bash
npx vitest run tests/http/management-catalog.test.ts tests/catalog/projection.test.ts tests/security/bearer-auth.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts src/http/catalog.ts tests/http/management-catalog.test.ts tests/catalog/projection.test.ts
git commit -m "feat(catalog): expose read-only router catalog"
```

If an existing management-catalog source file was reused, stage that exact file instead of `src/http/catalog.ts`.

---

### Task 12: Freeze the Routers ↔ Usage boundary with adversarial regression tests

**Files:**
- Create: `tests/integration/catalog-usage-boundary.test.ts`
- Modify: `scripts/security-audit.sh` only if the invariant is appropriate for the authoritative static gate.
- Modify: `docs/architecture/2026-09-15-cmm-routers-usage-responsibility-boundary.md` only if the already-frozen document needs a link to the new shared-core spec; do not rewrite its ownership rules.

**Interfaces:**
- Consumes: final shared catalog and projection.
- Produces no new runtime API; this is the boundary lock.

- [ ] **Step 1: Write adversarial tests**

Required cases:

```text
Usage-only OpenRouter key -> observability binding exists -> zero executable route authorization
same secretRef + explicit execution binding -> execution can become eligible
removing observability binding -> execution binding remains
removing execution binding -> route fails closed while Usage observation may remain
hidden route -> still emitted to Usage projection
fake/demo provider injected only into Usage fixture -> absent from real Routers catalog
Usage projection mutation attempt -> cannot mutate canonical RouteCatalog
```

- [ ] **Step 2: Run RED if any invariant is not yet enforced**

```bash
npx vitest run tests/integration/catalog-usage-boundary.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: RED only for genuinely missing boundary enforcement; do not manufacture a failing test if the previous tasks already satisfy every case. Record evidence.

- [ ] **Step 3: Apply the smallest missing enforcement, if required**

Changes are limited to the shared-core modules created in prior tasks. Do not modify CMM Usage runtime/frontend in this plan.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run tests/integration/catalog-usage-boundary.test.ts tests/catalog --no-file-parallelism --maxWorkers 1
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/catalog-usage-boundary.test.ts scripts/security-audit.sh docs/architecture/2026-09-15-cmm-routers-usage-responsibility-boundary.md src/catalog
git commit -m "test(catalog): lock routers usage responsibility boundary"
```

Stage only files actually changed.

---

### Task 13: Final independent verification and handoff to CMM Usage

**Files:**
- No production changes expected.
- Create: `docs/audits/2026-09-15-shared-route-catalog-final-audit.md`

**Interfaces:**
- Verifies all prior tasks.
- Produces a handoff contract for the later CMM Usage integration.

- [ ] **Step 1: Ensure the host is quiet before expensive verification**

CMM Usage demo/runtime, parallel Hermes builds, AutoClaw deep scans and other heavy harness jobs must be paused. Do not kill unrelated user processes automatically; verify and ask the user if a conflicting workload is still active.

- [ ] **Step 2: Run focused catalog suite**

```bash
npx vitest run tests/catalog tests/integration/catalog-provider-wave.test.ts tests/integration/catalog-usage-boundary.test.ts tests/http/cmmchat-route-resolution.test.ts tests/http/management-catalog.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: PASS.

- [ ] **Step 3: Run provider/consumer regression suite**

```bash
npx vitest run tests/providers tests/http/consumer-capability.test.ts tests/http/chat-only-enforcement.test.ts tests/registry/provider-registry.test.ts --no-file-parallelism --maxWorkers 1
```

Expected: PASS with the repository's intentional live integration skips only.

- [ ] **Step 4: Run build/type/security/diff gates**

```bash
npm run build
npm run typecheck
bash scripts/security-audit.sh
git diff --check
```

Expected: all exit 0.

- [ ] **Step 5: Run the full serial suite once on the quiet host**

```bash
npm run test:serial
```

Expected: PASS. If timeouts migrate among unrelated subprocess/I/O tests while focused tests remain green, stop and classify host/resource pressure; do not raise timeouts automatically.

- [ ] **Step 6: Review final diff against the approved spec**

Explicitly verify:
- no CMM Usage UI/runtime implementation changed;
- no provider adapter semantics were accidentally replaced;
- no raw secrets entered the catalog;
- Usage-only credential cannot execute;
- hidden route cannot be invoked by CMMChat;
- no silent PAYG/cross-provider fallback;
- `routeId` is the canonical executable identity;
- real provider IDs remain stable.

- [ ] **Step 7: Write final audit**

The audit must include these exact markers:

```text
SHARED_PROVIDER_DIRECTORY=PASS
PROVIDER_CONNECTION_SERVICE=PASS
EXECUTION_OBSERVABILITY_CREDENTIAL_SEPARATION=PASS
MODEL_IDENTITY_CANONICALIZATION=PASS
ACCESS_ROUTE_CANONICAL_EXECUTION_UNIT=PASS
ROUTE_VISIBILITY_SERVER_ENFORCED=PASS
CMMCHAT_ROUTE_ID_EXECUTION=PASS
CMM_USAGE_READ_ONLY_CATALOG_PROJECTION=PASS
USAGE_ONLY_CREDENTIAL_EXECUTION_ESCALATION=NONE
SILENT_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
REAL_STATE_OVER_FIXTURES=PASS
FULL_SERIAL_SUITE=PASS
SECURITY_AUDIT=PASS
LIVE_INFERENCE_COUNT=0
LIVE_ADMIN_CALLS=0
PUSH_PERFORMED=NO
MERGE_PERFORMED=NO
```

- [ ] **Step 8: Commit the audit**

```bash
git add docs/audits/2026-09-15-shared-route-catalog-final-audit.md
git commit -m "docs(catalog): record shared route catalog final audit"
```

---

## Self-Review

### Spec coverage

Covered:
- provider directory;
- accounts/products;
- secure secret references;
- execution vs observability bindings;
- provider connections;
- administrative model discovery;
- stable model identities;
- stable access routes;
- route visibility;
- route routability;
- CMMChat route execution;
- legacy compatibility during migration;
- read-only CMM Usage projection;
- real-state-over-fixtures boundary;
- fail-closed behavior;
- security/redaction;
- no silent PAYG/cross-provider fallback;
- final quiet-host verification.

### Placeholder scan

No implementation step depends on `TBD`, `TODO`, “similar to”, or an unspecified function. Task 10 contains an explicit ordered compatibility decision because the exact verified base may already contain a CMM-specific management surface; the implementer must select the first applicable existing contract and record that ruling before editing rather than inventing a duplicate API.

### Type consistency

The plan consistently uses:
- `ProviderDirectory`
- `CredentialBindingStore`
- `SecureCredentialResolver`
- `ProviderConnectionService`
- `ModelIdentityStore`
- `RouteCatalog`
- `CatalogRuntimeBridge`
- `RouterCatalogProjection`
- `AccessRoute`
- `routeId`

Later tasks consume only interfaces produced by earlier tasks.

## Execution prerequisite

Do not start Task 1 until the current `feature/provider-expansion-wave` base has a clean, quiet-host deterministic closure PASS. Then create an isolated worktree from that verified commit using the project worktree policy and copy this spec + plan into the new branch before implementation.

Recommended branch/worktree once the prerequisite is satisfied:

```text
branch: feature/shared-router-core
worktree: /Users/chris/CMM-Routers/.worktrees/shared-router-core
```
