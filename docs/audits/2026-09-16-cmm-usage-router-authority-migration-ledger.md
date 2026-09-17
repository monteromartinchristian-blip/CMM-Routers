# CMM Usage Router Authority Migration — Closure Ledger

**Branch:** `feature/cmm-usage`
**BASE (preflight):** `4e7174e`
**Final HEAD:** `4ba5486` (`refactor(usage): retire legacy router authority`)
**Commits on branch:** 22
**Push:** **NO** (`PUSH=NO` — nothing was pushed, merged, or published)

---

## 1. Scope

CMM Routers owns connectivity and execution. CMM Usage owns observability,
quota and history. This migration removed every place where CMM Usage acted as a
second writable operational authority, and made Router administration the single
source of truth for connections, custom endpoints and exact-route visibility.

---

## 2. Commits per task

| Task | Commit(s) | Subject |
|---|---|---|
| 1 | `6410aaf`, `282cd59` | exact-route visibility; fail-closed legacy migration |
| 2 | `83e56b3`, `5263ecb` | persist router administrative state; constrain credential refs |
| 3 | `98c2e5a`, `814eef3`, `b6f2ad5`, `c1a9769` | router administration service + atomic rollback |
| 4 | `4b583cf`, `2975159` | expose router administration API; admin visibility authoritative |
| 5 | `627671f`, `85b3f15` | enrich canonical router catalog; router product identity authoritative |
| 6 | `b53c88f`, `18379f0`, `3f11840`, `5cd457e` | delegate operational mutations; demo isolation closure |
| 7 | `e0b0fee` | migrate legacy visibility to router |
| 8 | `60f004e` | bind collectors to router identities |
| 9 | `f47500e` | remove parallel operational authority |
| 10 | `4340ad5` | preserve retired route history |
| 11 | `dd900de` | follow router authority contract (macOS client) |
| 12 | `4ba5486` | retire legacy router authority + architecture guards |
| 13 | (this ledger + visual handoff) | verification and closure |

Full list (newest first):

```
4ba5486 refactor(usage): retire legacy router authority
dd900de refactor(usage-macos): follow router authority contract
4340ad5 feat(usage): preserve retired route history
f47500e refactor(usage): remove parallel operational authority
60f004e refactor(usage): bind collectors to router identities
e0b0fee refactor(usage): migrate legacy visibility to router
5cd457e test(usage): make demo isolation guard assertions non-vacuous
3f11840 fix(usage): block demo mode from router administration surfaces
18379f0 fix(usage): keep demo mode off real router administration
b53c88f refactor(usage): delegate operational mutations to router
85b3f15 fix(usage): keep router product identity authoritative
627671f refactor(usage): enrich canonical router catalog
2975159 fix(catalog): keep admin visibility authoritative across reconcile
4b583cf feat(http): expose router administration API
c1a9769 fix(catalog): capture sibling routes before unavailable rollback
b6f2ad5 fix(catalog): scope connect rollback to operation
814eef3 fix(catalog): make router administration rollback atomic
98c2e5a feat(catalog): add router administration service
5263ecb fix(catalog): constrain secure credential references
83e56b3 feat(catalog): persist router administrative state
282cd59 fix(catalog): fail closed legacy route visibility migration
6410aaf fix(catalog): make route visibility exact-route state
```

---

## 3. Verification commands and results

All commands were run on the exact final commit `4ba5486`.

| # | Command | Result |
|---|---|---|
| 1 | Boundary-focused suite (`tests/catalog`, `tests/integration/catalog-usage-boundary.test.ts`, `tests/usage`, `tests/http/management-catalog.test.ts`, `tests/http/router-administration.test.ts`, `tests/http/production-composition.test.ts`) | **56 files, 402 tests passed, 0 failed** |
| 2 | `npm run typecheck` | **exit 0** |
| 2 | `npm run build` | **exit 0** |
| 2 | `git diff --check` | **clean** |
| 3 | `npm run test:serial` | **see §4** |
| 4 | `npx vitest run tests/publication --no-file-parallelism --maxWorkers 1` | **7 files, 45 tests passed, 0 failed** |
| 5 | `swift test --package-path apps/cmm-usage-macos --disable-sandbox` | **20 tests, 0 failures** |
| 5 | `swift run --package-path apps/cmm-usage-macos --disable-sandbox CMMUsageContractTests` | **PASS** |
| 5 | `swift build --package-path apps/cmm-usage-macos -c release --disable-sandbox` | **Build complete** |

Pre-existing, unrelated failures (documented, not attributable to this
migration): `tests/http/antigravity-multistep-tool-loop.test.ts` fails with a
`waitFor` timeout against a real `agy` child process. It is a live-binary
timing failure in `tests/providers`/`tests/http`, a namespace this migration
never touched (no change under `src/providers/**` or `src/bridge/**`).

**Note on Swift sandbox:** every `swift` invocation requires `--disable-sandbox`
in this environment (and for `swift run` the flag must precede the executable
name); otherwise the toolchain fails with
`sandbox-exec: sandbox_apply: Operation not permitted` while compiling the
package manifest. This is an environment restriction, not a code defect.

---

## 4. Complete serial Node suite

Command: `npm run test:serial`, run on the exact final commit `4ba5486`.

```
Test Files  215 passed | 5 skipped (220)
     Tests  1312 passed | 25 skipped (1337)
  Duration  1893.29s (tests 99%, import 1%)
```

**215 files passed, 0 failed. 1312 tests passed, 0 failed.** These are the
measured counts from this run on this commit — not copied from any historical
run. Notably the suite completed with **zero** failures, so even the
environment-coupled `antigravity-multistep-tool-loop` case passed in the serial
configuration.

---

## 5. Ownership invariants (verified from source and behaviour)

`git grep -n -E 'VisibilityStore|ConnectionManagementService|provider:custom:|route:custom:' -- src/usage src/http src/index.ts`

**Interpretation:**

- **No `provider:custom:` / `route:custom:` anywhere.** Usage no longer
  fabricates operational identities (Task 8), and the architecture guard added
  in Task 12 locks this in.
- **`VisibilityStore` occurrences are migration/history-only or inert:**
  - `production-runtime.ts` — constructed once as the **read-only legacy
    source** for `migrateLegacyVisibility` (`Pick<VisibilityStore, "list">`).
  - `legacy-visibility-migration.ts` — reads legacy rows, writes only through
    `admin.setRouteVisibility`.
  - `server.ts` / `index.ts` — an inert optional field (`cmmUsageVisibility`)
    that **no read consults**; retained only to avoid churning four test call
    sites, and recorded for the later Rule 7 deprecation step.
  - Remaining hits are comments or the class definition itself.
- **`ConnectionManagementService` occurrences are compatibility delegation
  only:** it performs no operational write of its own; every mutation delegates
  to `RouterAdministrationService`, and it has no `ManagedConfigStore`
  dependency.
- **Router administration owns current mutation flow:** 28 references to
  `setRouteVisibility` / `RouterAdministrationService` across `src`.

Behavioural proof: a legacy SQLite `hidden` preference cannot override Router
`visibleOn`, and the legacy row is **retained** rather than deleted (Rule 7).

---

## 6. Intentionally retained legacy compatibility artifacts

| Artifact | Why retained | Proof it is not current authority |
|---|---|---|
| `visibility_preferences` table + `VisibilityStore` | Real installations still need the table for migration/history; schema removal is a separate future DB migration. | Guard asserts read-only `Pick<..., "list">`, no `upsertVisibilityPreference`, no `legacy.set(`; the only write target is `admin.setRouteVisibility`. |
| `/v1/cmm/usage/catalog/visibility` endpoint | Compatibility read for the shipped client. | Reports **Router effective** visibility; never consults SQLite preferences. |
| `/v1/cmm/usage/connections/**` | Compatibility delegate for the shipped client. | Thin delegate with no independent state store; fails closed (503) when Router administration is absent. |
| `ServerOptions.cmmUsageVisibility` | Inert; avoids churning four test call sites. | Nothing reads it; guard tests prove no effective-visibility path uses `VisibilityStore`. |

---

## 7. Preserved local work

`git status --short` after the final commit:

- Tracked worktree and index: **clean**.
- The **19 pre-existing untracked `.superpowers/` paths remain present and
  untouched** (probes, dogfood config/backups, Swift window helpers,
  `visual-run/`). They were never read for logic, staged, renamed, or deleted.

---

## 8. Completion criteria evidence

| Criterion | Evidence |
|---|---|
| Router owns connections, custom endpoints, exact-route visibility | `RouterAdministrationService` is the sole mutation target; `connection-management-service.ts` delegates only. |
| Usage owns observability, quota, history | Usage reads Router projection and attaches quota/freshness/offer/history; it writes none of the operational graph. |
| Visibility ≠ connection ≠ collection ≠ accounting | Hiding a route leaves it routable, connected, and collected; sibling routes unaffected. History survives removal. |
| Visibility belongs to the exact `AccessRoute` | Guards and tests reject provider/product/model/workspace-scoped and `inherit` preferences (fail closed). |
| No second writable operational authority | Task 12 guard tests; no `ManagedConfigStore` in connection mutation; no `*:custom:*` fabrication. |
| Execution and observability credentials are independent, explicit bindings | `executionAuthorized` / `observabilityAuthorized` reported separately; four collector states explicit. |
| Usage does not fabricate canonical identities | No `*:custom:*`; collectors require a `UsageCollectorBinding`. |
| Historical Usage survives route disconnect/removal | Task 10 `getRouteHistory` returns all observations with `currentOperationalRoute: false`; no `DELETE`/`ON DELETE CASCADE` in Usage storage. |
| No raw secrets in tracked config, Usage SQLite, projections, logs, reports, UI | Secret-redaction on every HTTP read; `ProviderPresentationTests` asserts no `credentialRef`/keychain reference in payloads. |
| NORMAL mode shows only real state; DEMO is isolated and visibly synthetic | Canonical administration mutations 403, compatibility mutations 503, `keychainWrites=0`, `shared.json` unchanged in demo mode. |

---

## 9. Residual findings

1. Custom OpenAI-compatible endpoints do not collect until a composition
   supplies a `UsageCollectorBinding`. Intended (Usage must not fabricate
   identities); the mechanism is complete and tested.
2. `openai-api` and `qwen-payg` provider-directory entries have no current
   Router counterpart and read `available` — honest, not fabricated.
3. `cmmUsageVisibility` and `ProductionUsageRuntime.visibility` are inert
   leftovers for the later Rule 7 deprecation step.
4. `providerModelId` on bound collectors carries the canonical route id (a
   required domain field with no model identity in the binding). Verified inert:
   no `src/usage/**` consumer reads it.
5. Quota snapshots are not binding-filtered. Unreachable today (bound
   collectors return `unsupported` for quotas); a candidate for hardening.

---

## 10. Push status

**`PUSH=NO`.** No push, merge, publish, `git reset`, `git clean`, `git stash`,
or history rewrite was performed at any point. The branch remains local at
`4ba5486`.
