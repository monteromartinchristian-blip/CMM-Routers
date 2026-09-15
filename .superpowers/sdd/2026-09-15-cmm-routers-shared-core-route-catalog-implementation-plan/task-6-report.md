# Task 6 report — executable route catalog

## Status

Task 6 is implemented and committed on `feature/shared-router-core`.

- Commit: `e43466f009208ab79c0daa433d5009c0c5e763c2` (`feat(catalog): add executable route catalog`)
- Production file: `src/catalog/route-catalog.ts`
- Test file: `tests/catalog/route-catalog.test.ts`
- Report file: `.superpowers/sdd/2026-09-15-cmm-routers-shared-core-route-catalog-implementation-plan/task-6-report.md`
- `LIVE_ADMIN_CALLS=0`
- `LIVE_INFERENCE_COUNT=0`

## RED evidence

Created `tests/catalog/route-catalog.test.ts` before the production module.

Command:

```text
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
```

Result: exit `1`. Vitest discovered the test file but failed before running tests because `../../src/catalog/route-catalog.js` did not exist. This was the expected missing-implementation failure.

## Implementation

`RouteCatalog` now:

- stores multiple exact `AccessRoute` records for one `ModelIdentity`;
- validates route IDs with the existing stable route-ID helper;
- retains visibility and routability as independent route properties;
- returns hidden and unavailable routes from historical `list()` state;
- filters `listVisible(surface)` only by the requested surface;
- makes `resolveForConsumer(routeId, surface)` fail closed for unknown, hidden, or explicitly non-routable routes;
- delegates execution readiness to `ProviderConnectionService.validateExecution(connectionId)` and verifies that the ready connection still belongs to the exact route provider;
- resolves only the requested route ID, with no substitution by model identity, provider, billing class, or another route;
- preserves route-specific capabilities, including CHAT_ONLY truth;
- marks every exact `(connectionId, providerModelId)` route unavailable without deleting historical route records;
- snapshots stored and returned route state so caller mutation cannot rewrite catalog truth.

Because execution readiness is delegated to `ProviderConnectionService.validateExecution`, an observability/CMM Usage credential cannot authorize route execution: only an enabled execution binding accepted by that service can make the connection ready.

## GREEN evidence

Focused command:

```text
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
```

Result: exit `0`; `1` test file passed and `7` tests passed.

Required validation:

```text
npm run typecheck
git diff --check
```

Result before commit: exit `0` for both commands; TypeScript completed without errors and no whitespace errors were reported.

The staged commit was also checked with `git diff --cached --check`; it contained exactly:

```text
src/catalog/route-catalog.ts
tests/catalog/route-catalog.test.ts
```

## Coverage against Task 6 brief

- one `ModelIdentity` with multiple routes: covered;
- route IDs vary by connection/provider-native model/execution profile: covered;
- hidden route retained in `list()` and absent from CMMChat picker projection: covered;
- manual hidden-route resolution fails closed: covered;
- missing execution authorization and disabled connection fail closed: covered;
- CHAT_ONLY capability truth remains route-specific: covered;
- no fallback to another route sharing the same `modelIdentityId`: covered;
- provider-model disappearance marks the route unavailable without deletion: covered.

## Concerns

- `markUnavailable(connectionId, providerModelId)` is an explicit reconciliation hook. The later production discovery/composition task must call it when a previously known provider model disappears from discovery.
- `resolveForConsumer` validates execution readiness on each resolution. Task 8 may need the returned connection snapshot as well; it should preserve the same exact-route semantics if it performs an additional validation at the runtime bridge.

`LIVE_ADMIN_CALLS=0`

`LIVE_INFERENCE_COUNT=0`

## Fix Round 1 — exact provider-model binding consistency

Independent review found that `RouteCatalog.upsert()` accepted any existing
`modelIdentityId` without proving that the exact provider, connection and
provider-native model tuple was bound to that identity. Because `routeId` does
not include `modelIdentityId`, stable route-ID validation alone could not catch
that mismatch.

### RED evidence

Added the regression `rejects a route whose exact provider model binding belongs to another identity`.
The test registers two existing model identities, binds the route's exact
`(providerId, connectionId, providerModelId)` tuple to the first identity, then
declares the route under the second identity.

Command:

```text
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
```

Result: exit `1`; `8` tests were collected and exactly `1` failed because
`catalog.upsert(mismatchedRoute)` did not throw. The previous `7` Task 6 tests
remained passing.

### Minimal fix and GREEN evidence

`RouteCatalog.upsert()` now resolves the exact provider-model binding through
`ModelIdentityStore.resolveProviderModel(providerId, connectionId, providerModelId)`
and rejects the route unless that binding's `modelIdentityId` equals the
route's declared `modelIdentityId`. The existing unknown-identity check remains
in place, and route resolution, visibility, routability, CHAT_ONLY truth and
no-fallback behavior are unchanged.

Focused verification:

```text
npx vitest run tests/catalog/route-catalog.test.ts --no-file-parallelism --maxWorkers 1
npm run typecheck
git diff --check
```

Result: exit `0` for all commands; `1` test file and `8` tests passed,
TypeScript completed without errors, and no whitespace errors were reported.

Fix Round 1 commit message: `fix(catalog): enforce exact route identity binding`.

`LIVE_ADMIN_CALLS=0`

`LIVE_INFERENCE_COUNT=0`
