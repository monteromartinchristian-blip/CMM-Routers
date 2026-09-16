# CMM Routers — Shared Core — Independent Audit V1

**Date:** 2026-09-15
**Auditor:** ChatGPT, independent exact-head source review
**Branch under review:** `feature/shared-router-core`
**Audited HEAD:** `679778eba41f077fd07aa81e83504ab35682368e`
**Audited tree (collector):** `4333a930179cb0c87bf1aa2caefbf0059e5bcef5`
**Exact-head archive SHA-256:** `1a246d720988cf1422d28fffabbc709c3e22c6ca99e89843ac24273def0f9f83`
**Baseline:** `150aa33f51216cbe4a4f468566f9337424e938c1`

## Verdict

```text
INDEPENDENT_AUDIT_V1=FAIL_TO_MERGE
CRITICAL=0
MAJOR=2
IMPORTANT=2
MINOR=0

SECURITY_REGRESSION_FOUND=NO
SILENT_FALLBACK_FOUND=NO
SECRET_LEAK_FOUND=NO

FUNCTIONAL_COMPLETENESS=FAIL
SHARED_CATALOG_FRESHNESS=FAIL
ROUTE_BOUND_GENERIC_OPENAI_EXECUTION=PASS
EXECUTION_OBSERVABILITY_SEPARATION=PASS
SERVER_SIDE_HIDDEN_ROUTE_ENFORCEMENT=PASS
READ_ONLY_USAGE_PROJECTION_SAFETY=PASS

PUSH_RECOMMENDED=NO
MERGE_RECOMMENDED=NO
REMEDIATION_REQUIRED=YES
```

The implementation is substantial and the deterministic verification is genuinely strong, but the branch is not ready to merge as the completed implementation of the approved 13-task plan. Two cross-cutting integration defects remain: production advertises executable routes for adapters that cannot execute a resolved `AccessRoute`, and the shared catalog is only a startup snapshot rather than a reconciled view of later discovery truth.

This is a functional/spec-completeness failure, **not** a security catastrophe. The affected route path fails closed instead of silently falling back or spending through another provider.

---

## Independent evidence binding

The supplied archive independently hashes to:

```text
1a246d720988cf1422d28fffabbc709c3e22c6ca99e89843ac24273def0f9f83
```

which matches the supplied `.sha256` sidecar.

The collector reported `ARCHIVE_FILE_COUNT=716` versus `HEAD_FILE_COUNT=659` and stopped with `ARCHIVE_FILE_COUNT_MISMATCH`. That collector verdict is a **collector bug, not repository evidence**: independent tar inspection found exactly:

```text
non-directory archive entries = 659
directory entries             = 57
total tar entries             = 716
```

So the archive contains the expected 659 tracked files plus tar directory entries. The source archive is valid for this review; rerunning the seven-minute suite solely for that count error is unnecessary.

The independent reexecution before that collector bug passed:

```text
focused catalog/CMMChat/Usage = 12/12 files, 83/83 tests
provider/consumer regression = 82/82 files, 486/486 tests
full serial                   = 166 pass + 5 skipped
tests                         = 959 pass + 25 skipped
build                         = PASS
typecheck                     = PASS
security audit                = PASS
git diff --check              = PASS
```

---

# Findings

## MAJOR-01 — `routable=true` / visible routes can be impossible to execute by `routeId`

### Why this matters

`AccessRoute` is frozen as the canonical executable unit and `routeId` is supposed to select the exact provider + connection + provider model + execution profile. Production currently creates routes that claim to be routable and exposes them to CMMChat, while the runtime bridge cannot execute them through their real adapter.

The failure is safe — it returns `unknown_model` rather than falling back — but it means the central product promise is not actually true for important providers.

### Source proof

`src/catalog/runtime-bridge.ts` defines a private execution extension:

```ts
interface ResolvedExecutionAdapter extends ProviderAdapter {
  runWithResolvedExecution(...): AsyncIterable<RouterEvent>;
}
```

`RouteBoundAdapter.run()` rejects any delegate that does not implement that extension:

```ts
if (!supportsResolvedExecution(delegate)) {
  yield {
    type: "error",
    error: new RouterError("unknown_model", "Unknown or unavailable route"),
  };
  return;
}
```

Exact-head source scan found `runWithResolvedExecution` implemented only by:

```text
src/providers/openai-compatible/adapter.ts
```

and not by the dedicated/subscription adapters:

```text
src/providers/codex/adapter.ts          (chatgpt)
src/providers/claude/adapter.ts         (claude)
src/providers/antigravity/adapter.ts    (google)
src/providers/command-code/adapter.ts
src/providers/cavoti/adapter.ts
```

At the same time, `src/index.ts` creates catalog routes for **every registered provider**. For the three subscription bridges, `routeIsActivated()` returns `true` unconditionally, and all created routes are placed on the CMMChat surface:

```ts
if (SUBSCRIPTION_BRIDGE_IDS.includes(providerId)) return true;
```

and:

```ts
routable: routeIsActivated(...),
visibility: {
  visibleOn:
    model.capability === "CHAT_ONLY"
      ? ["cmmchat_model_picker", "admin_console"]
      : ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"],
},
```

So a ChatGPT/Codex, Claude or Google route can be advertised as both `routable: true` and visible in the CMMChat picker but fail when actually invoked as `route:<routeId>`.

The same structural problem applies to Command Code and Cavoti whenever they are registered and their route activation permits execution.

### Why the test suite missed it

The explicit HTTP route tests exercise:
- a synthetic `RecordingAdapter` that implements the new extension; and
- a real **generic OpenAI-compatible** DeepSeek adapter.

They do not execute a production-composed `routeId` through the real Codex, Claude, Antigravity, Command Code or Cavoti adapters.

The final in-tree audit states that an adapter unable to consume the resolved binding “fails closed”. That is true but insufficient: a route advertised as routable must not be knowingly impossible to execute.

### Required remediation

Preferred:

1. implement explicit route-bound execution for each dedicated adapter that is meant to be executable by CMMChat/shared catalog;
2. preserve each adapter's native subscription/profile/session semantics rather than forcing API-key semantics;
3. add production-composed deterministic routeId execution tests for:
   - ChatGPT/Codex;
   - Claude;
   - Google/Antigravity;
   - Command Code when acknowledged;
   - Cavoti when acknowledged.

At minimum, until an adapter supports exact resolved-route execution, the composition layer must mark those routes **non-routable and not visible to executable product surfaces**. Do not advertise them as executable merely because model activation is true.

A durable design would make route-bound execution support an explicit adapter/provider capability rather than infer it only at request time.

---

## MAJOR-02 — Shared catalog discovery is a startup snapshot and is not reconciled after provider changes

### Why this matters

The approved spec requires:

```text
A model disappearing from provider discovery becomes unavailable.
Routes should be updated in place when the same stable provider
connection/model route is rediscovered.
```

The current production composition does not do this.

### Source proof

`createProductionRegistry()` performs:

```text
registry.refresh()
→ composeSharedCatalog(...)
```

`composeSharedCatalog()` then iterates one snapshot:

```ts
for (const model of registry.listModels()) {
  ...
  routeCatalog.upsert(...)
}
```

After startup, legacy `ProviderRegistry.resolve()` may refresh its own discovery cache when its 30-second TTL expires, but no code reconciles that refreshed model set into `ModelIdentityStore` or `RouteCatalog`.

`ProviderConnectionService.discoverModels(connectionId)` exists, and `RouteCatalog.markUnavailable(connectionId, providerModelId)` exists, but independent production-reference inspection found no production caller that uses those operations to keep the catalog synchronized. `markUnavailable()` is used only by tests.

Consequences:

- a provider model removed upstream can remain `routable: true` in the shared catalog;
- a newly discovered model does not appear until Router restart;
- CMM Usage's read-only projection can become stale;
- CMMChat's route picker can present stale route truth;
- connection/discovery status and catalog routability can diverge.

### Required remediation

Introduce one canonical catalog reconciliation path, owned by CMM Routers:

```text
discover exact connection
→ preserve/update ModelIdentity binding
→ upsert current AccessRoutes
→ mark previously-known missing routes unavailable
→ update connection status
→ publish same canonical store to CMMChat and CMM Usage
```

Add deterministic tests where discovery result A is replaced by result B after startup and prove:

- unchanged routes retain stable `routeId`;
- newly discovered models appear;
- removed models remain in identity/history but become non-routable;
- Usage projection and CMMChat projection see the reconciled truth;
- a discovery failure affects only its connection and does not silently delete history.

---

## IMPORTANT-01 — Production has no real `RouteVisibility` policy source

### Evidence

The domain model and server-side enforcement are correctly implemented. Hidden routes created in tests cannot be manually invoked by CMMChat.

However, production composition hardcodes visibility for every discovered route:

```text
CHAT_ONLY      -> cmmchat_model_picker + admin_console
CHAT_AND_TOOLS -> cmmchat_model_picker + cmmcode_model_picker + admin_console
```

There is no production config/admin/provider policy that can express the approved architecture's example:

```text
OpenRouter route -> visibleOn: []
```

while still keeping it observable by CMM Usage.

### Impact

The mechanism exists, but the independent visibility dimension is not yet operable as product state. In today's composition, essentially every discovered route is shown to CMMChat regardless of intended per-route exposure policy.

### Required remediation

Provide a canonical Router-owned visibility policy/config/state layer, independent of:
- connection;
- routability;
- Usage collection;
- billing.

Keep server-side enforcement exactly as it is.

---

## IMPORTANT-02 — Production `Account` / `ProviderProduct` identities are synthetic per-provider defaults

### Evidence

For every registered provider, production currently synthesizes:

```ts
const accountId = `account:${providerId}:default`;
const productId = `product:${providerId}:default`;
```

with labels such as:

```text
ChatGPT / Codex default account
```

There is one account/product pair per provider composition, not an identity tied to the actual provider account/subscription/API product.

### Impact

This is dangerous specifically for the next CMM Usage phase:

- replacing one API credential with another provider account reuses the same canonical account/product IDs;
- Usage history could be attributed across different real accounts;
- multiple accounts/products for one provider cannot be represented by current production composition even though the domain model permits them.

The approved spec says an account may have multiple products and multiple connections. The current implementation is therefore a bootstrap identity, not yet trustworthy “real account/product truth”.

### Required remediation

Before CMM Usage treats these IDs as durable accounting identities:

- derive/configure stable account identity separately from provider identity;
- allow multiple connections/products per provider;
- preserve account/product identity across restarts without conflating credential replacement;
- use `externalAccountRef` or another non-secret provider/account identifier when available;
- if real identity is unavailable, explicitly represent it as unresolved/unknown rather than silently calling it a real default account.

---

# What passed independent review

The failures above should not obscure the substantial correct work in this branch.

## Credential separation

Execution and observability bindings are separate stores/APIs. An observability-only credential does not satisfy the execution lookup. The same physical `secretRef` may be deliberately used through two explicit bindings without one creating the other.

**Verdict: PASS.**

## Secret safety / projection

The Usage/admin projection explicitly constructs DTOs and excludes:
- raw secret values;
- `secretRef`;
- credential binding IDs;
- profile refs;
- endpoint refs;
- external account refs;
- auth blobs.

**Verdict: PASS.**

## Server-side hidden-route enforcement

`RouteCatalog.resolveForConsumer()` enforces `visibleOn` and `routable` before runtime execution. A manually supplied hidden CMMChat `routeId` does not bypass visibility.

**Verdict: PASS.**

## Exact generic OpenAI-compatible route binding

For adapters implementing `runWithResolvedExecution`, route execution binds the selected:
- provider;
- connection;
- provider-native model;
- credential;
- endpoint;
- execution profile.

The DeepSeek route test demonstrates the resolved secondary endpoint + route-specific credential path.

**Verdict: PASS for generic OpenAI-compatible adapters.**

## No silent fallback

Explicit route resolution errors do not call the legacy model resolver. Unsupported resolved-route adapters fail closed rather than switching provider or billing class.

**Verdict: PASS.**

## Publication/security gates

The late vendor-shaped fixture issue was remediated without weakening the scanner. The fresh security audit and the full deterministic suite pass.

**Verdict: PASS.**

---

# Merge decision

Do **not** merge `feature/shared-router-core` at `679778eba41f077fd07aa81e83504ab35682368e`.

The minimum merge gate is:

```text
MAJOR-01=FIXED_AND_REVIEWED
MAJOR-02=FIXED_AND_REVIEWED
FULL_SERIAL_SUITE=PASS
BUILD=PASS
TYPECHECK=PASS
SECURITY_AUDIT=PASS
DIFF_CHECK=PASS
WORKTREE=CLEAN
PUSH=NO
MERGE=NO
```

`IMPORTANT-01` and `IMPORTANT-02` should ideally be resolved in the same remediation because CMM Usage is the next consumer of this catalog. If intentionally deferred, they must be explicitly downgraded into a documented scope boundary before Usage is allowed to treat visibility/account/product fields as canonical real state.

## Recommended next action

Run one narrow remediation program, not another 13-task rebuild:

```text
R1 — executable-route capability truth
R2 — subscription/dedicated adapter route-bound execution
R3 — live catalog reconciliation after discovery
R4 — production visibility policy
R5 — durable account/product identity semantics
R6 — independent re-audit + full gates
```

Preserve all existing correct commits. Do not reset or rewrite the 9-hour SDD history.
