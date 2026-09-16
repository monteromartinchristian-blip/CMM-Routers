# CMM Routers — Shared Core — Independent Audit V2

**Date:** 2026-09-16
**Auditor:** ChatGPT independent exact-tree source review
**Branch:** `feature/shared-router-core`
**Audited HEAD (manifest):** `7e51cd9f3b98049f76047c18987c583c705a6dd5`
**Audited tree:** `e4bb2c8f6b111dd516d753b3d96cbfaac2e8a203`
**Bundle SHA-256:** `9ce5eda6ea697f1442e440668b59b10ea58c8d558cca64500d8218fbd98c03a9`

## Verdict

```text
INDEPENDENT_AUDIT_V2=TECHNICAL_PASS_CLOSURE_CLEANUP_REQUIRED

CRITICAL=0
MAJOR=0
IMPORTANT=0
MINOR=4

R1_EXECUTABLE_ROUTE_TRUTH=PASS
R2_DEDICATED_EXACT_ROUTE_EXECUTION=PASS
R3_CATALOG_RECONCILIATION=PASS
R4_PRODUCTION_ROUTE_VISIBILITY_POLICY=PASS
R5_DURABLE_ACCOUNT_PRODUCT_IDENTITY=PASS

SECURITY_AUDIT_EXACT_TREE=PASS
SECRET_LEAK_FOUND=NO
SILENT_PAYG_FALLBACK_FOUND=NO
CROSS_PROVIDER_FALLBACK_FOUND=NO

FUNCTIONAL_REMEDIATION=PASS
MERGE_READY=NO
MERGE_BLOCKER_CLASS=DOCS_AND_CLOSURE_ONLY
```

The two Major and two Important findings from independent Audit V1 are
technically remediated in the exact source tree. I found no remaining
Critical, Major, or Important code/architecture defect in the V1 remediation
scope.

The branch should nevertheless receive one small documentation-only closure
commit before merge because the committed remediation evidence has three
minor inconsistencies described below.

## Evidence binding

The uploaded bundle independently hashes to:

```text
9ce5eda6ea697f1442e440668b59b10ea58c8d558cca64500d8218fbd98c03a9
```

matching both the uploaded sidecar and manifest.

I reconstructed the Git object tree directly from the archive contents. The
result was:

```text
RECONSTRUCTED_TREE=e4bb2c8f6b111dd516d753b3d96cbfaac2e8a203
MANIFEST_TREE=e4bb2c8f6b111dd516d753b3d96cbfaac2e8a203
TREE_BINDING=PASS
```

This binds the reviewed source bytes to the manifest's final tree.

## Verification scope

### Independently executed here

- SHA-256 verification of the exact uploaded bundle.
- Exact Git tree reconstruction and tree-hash comparison.
- Source-level review of the V1 findings and their remediation paths.
- Fresh `bash scripts/security-audit.sh` against the reconstructed exact tree:
  `SECURITY_AUDIT=PASS`, exit 0.
- V1→V2 remediation-range whitespace inspection.

### Supplied evidence, not independently re-executed in this sandbox

The archive intentionally does not include `node_modules`, so I did not
pretend to reproduce dependency-backed Vitest/build/typecheck runs here. The
manifest and user-provided closure evidence report:

```text
FOCUSED_REMEDIATION_FILES=12/12 PASS
FOCUSED_REMEDIATION_TESTS=68/68 PASS

PAYG_SANITIZED_RERUN=51/51 PASS

FULL_SERIAL_TEST_FILES=171 PASS / 5 SKIPPED
FULL_SERIAL_TESTS=980 PASS / 25 SKIPPED
FULL_SERIAL_EXIT_CODE=0

BUILD=PASS
TYPECHECK=PASS
SECURITY_AUDIT=PASS
WORKTREE=CLEAN
PUSH=NO
MERGE=NO
```

Those results are consistent with the source reviewed here, but only the
security audit, archive binding, and source audit were independently executed
in this environment.

---

# V1 finding closure

## MAJOR-01 — executable route truth — PASS

Audit V1 found that production could advertise a route as executable even
when its real adapter could not honor an exact resolved `AccessRoute`.

The remediation now has an explicit provider capability:

```ts
export interface ProviderExecutionCapabilities {
  readonly exactResolvedRoute: boolean;
}
```

`CatalogRuntimeBridge` requires both:

```text
executionCapabilities.exactResolvedRoute === true
AND
runWithResolvedExecution is actually implemented
```

before route-bound execution can proceed. A look-alike duck-typed method alone
is insufficient.

Production route composition also includes this capability in the `routable`
decision, while visibility remains a separate policy.

### Dedicated adapters

Exact resolved-route execution is now implemented by:

- `CodexAdapter`
- `ClaudeAdapter`
- `AntigravityAdapter`
- `CommandCodeAdapter`
- `CavotiAdapter`
- `OpenAiCompatibleAdapter`

The subscription adapters validate their exact provider/connection kind,
configured profile/runtime semantics, execution profile, and runtime
authorization marker before delegating to their existing native session path.

Command Code and Cavoti additionally bind execution to the resolved endpoint
and resolved execution credential rather than the discovery client's
credential.

The production-composition test
`tests/integration/dedicated-route-production.test.ts` drives explicit
`route:<routeId>` execution through all five dedicated production adapters and
checks route-resolved credentials for Command Code and Cavoti.

**V2 verdict: PASS.**

## MAJOR-02 — live catalog reconciliation — PASS

Audit V1 found that the shared catalog was a startup snapshot.

The remediation introduces `CatalogReconciler` and wires it into production:

```text
registry discovery cache
→ ProviderConnectionService
→ CatalogReconciler
→ ModelIdentityStore + RouteCatalog
```

Production performs forced reconciliation at startup. Later management catalog
reads reconcile again subject to the refresh interval, and explicit route
resolution triggers reconciliation for the selected connection before
consumer resolution.

The reconciler:

- upserts current models/routes;
- preserves stable IDs for unchanged route identity;
- marks previously known missing models non-routable;
- preserves model identity/history;
- marks routes unavailable on discovery failure rather than silently retaining
  stale executable truth;
- isolates reconciliation by connection.

`tests/integration/catalog-reconciliation-production.test.ts` exercises the
required transition:

```text
A = stable-model, removed-model
B = stable-model, added-model
```

and verifies stable route ID, addition, removal/unavailability, preserved
history, and discovery-failure behavior.

**V2 verdict: PASS.**

## IMPORTANT-01 — real production RouteVisibility policy — PASS

`RouteVisibilityPolicy` is now Router-owned configuration state independent
from connection health, routability, billing, and Usage observation.

Rules are keyed by provider/model and can specify `visibleOn: []`. The policy
also applies a safety ceiling so an adapter that cannot execute an exact route
cannot be exposed on executable product surfaces.

The full Router/Usage projection retains hidden routes, while the CMMChat
projection filters them. `RouteCatalog.resolveForConsumer()` enforces
visibility server-side before adapter lookup, so manually supplying a hidden
route ID cannot bypass the policy.

**V2 verdict: PASS.**

## IMPORTANT-02 — Account / ProviderProduct identity — PASS

Production no longer fabricates `account:<provider>:default` and
`product:<provider>:default` as real identities.

The configuration model now supports:

- resolved accounts backed by a non-secret `externalAccountRef`;
- explicitly unresolved accounts;
- multiple products;
- multiple represented connections;
- at most one primary runtime connection per provider, with secondary
  connections represented as disabled rather than overclaimed as executable.

Stable account IDs distinguish resolved and unresolved namespaces. Resolved
identity is based on provider + external account reference; changing local
labels does not change the account ID, while changing the verified external
identity does.

When no catalog identity is configured, production creates no fake
Account/Product. The connection projection reports unresolved identity.

Public projections omit `externalAccountRef`, secret refs, credential-binding
IDs, profile refs, endpoint refs, and auth material.

**V2 verdict: PASS.**

---

# Minor findings

## MINOR-01 — remediation ledger maps the V1 findings incorrectly

`docs/audits/2026-09-16-shared-core-remediation-ledger.md` currently labels
R2 dedicated-adapter execution as `MAJOR-02`.

That is not what V1 says:

```text
V1 MAJOR-01 = executable-route truth, including dedicated-adapter execution
V1 MAJOR-02 = shared catalog reconciliation
V1 IMPORTANT-01 = production RouteVisibility policy
V1 IMPORTANT-02 = Account / ProviderProduct identity
```

The implementation itself contains the R3 reconciliation fix, so this is an
evidence/mapping defect, not a missing code fix.

Correct mapping should be approximately:

```text
MAJOR-01    → e5012e3 + d636f80 + 698bafc
MAJOR-02    → 7e51cd9 (catalog reconciliation portion)
IMPORTANT-01→ d636f80 + 7e51cd9
IMPORTANT-02→ 7e51cd9
R6          → 7e51cd9
```

## MINOR-02 — final remediation closure artifacts are internally incomplete

The remediation contract required a final remediation audit artifact with
explicit closure markers. The exact tree contains the V1 audit and the
2026-09-16 remediation ledger, but no dedicated final remediation audit file.

In addition, the plan-specific SDD progress ledger under:

`.superpowers/sdd/2026-09-15-cmm-routers-shared-core-remediation-v1/progress.md`

stops during R2 and still contains `PENDING` lines. This conflicts with the
final closure status and makes the recovery ledger non-authoritative.

This does not invalidate the production code; it should be reconciled before
the branch is treated as formally closed.

## MINOR-03 — the remediation range is not `git diff --check` clean

A direct V1→V2 range check found only documentation whitespace debt:

```text
docs/audits/2026-09-16-shared-core-remediation-ledger.md:3 trailing whitespace
docs/audits/2026-09-16-shared-core-remediation-ledger.md:4 trailing whitespace
docs/audits/2026-09-16-shared-core-remediation-ledger.md:5 trailing whitespace
docs/audits/2026-09-16-shared-core-remediation-ledger.md:85 new blank line at EOF
```

This explains how a post-commit `git diff --check` on a clean worktree could
report PASS while not proving the already-committed remediation range was
clean. The production-code range itself did not surface whitespace defects in
this check.

## MINOR-04 — the remediation manifest records the wrong starting HEAD

The uploaded remediation manifest records:

```text
START_HEAD=698bafc7ea6812306cd0157721838c9d8d0b536a
```

but that same closure evidence identifies `698bafc...` as the dedicated-route
remediation commit, and the remediation recovery ledger records the actual
starting point as:

```text
0d511c606eebcc44cfbc1c9276346f2f9aa7c35b
```

The final implementation HEAD/tree and bundle binding are unaffected. This is
another provenance/closure metadata error, not a production-code defect. The
replacement closure manifest should preserve the correct remediation start
HEAD.

---

# Advisory, not scored

`config/shared.example.json` does not yet demonstrate the new
`routeVisibility` or provider `catalog` structures, and the README roadmap
still speaks of dynamic catalog reconciliation as future work even though the
core reconciliation mechanism now exists.

That is worth updating during normal documentation maintenance, but I do not
treat it as a merge-blocking defect for the audited R1–R6 scope.

---

# Merge decision

The functional remediation is accepted:

```text
V1_CRITICAL_REMAINING=0
V1_MAJOR_REMAINING=0
V1_IMPORTANT_REMAINING=0

R1=PASS
R2=PASS
R3=PASS
R4=PASS
R5=PASS
```

Do **not** merge the current `7e51cd9...` tree yet. Make one documentation-only
closure commit that:

1. corrects the V1 finding→remediation mapping;
2. reconciles the plan-specific remediation progress ledger with final state;
3. adds the final remediation/independent-audit closure artifact;
4. removes the range whitespace debt;
5. proves the closure commit touches no production/test/config source.

After that docs-only commit, no rerun of the 980-test suite is required solely
because of documentation changes. Re-run `git diff --check` on the staged
closure diff and the security audit, verify a clean worktree, and preserve
`PUSH=NO` / `MERGE=NO` until the final integration decision.
