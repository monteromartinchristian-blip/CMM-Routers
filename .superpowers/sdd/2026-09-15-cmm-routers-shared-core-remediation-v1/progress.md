# CMM Routers shared-core remediation V1 ledger

Starting remediation HEAD: `0d511c606eebcc44cfbc1c9276346f2f9aa7c35b`

## R1 — truthful exact-route execution capability

- Finding: `MAJOR-01` capability boundary.
- Base: `0d511c606eebcc44cfbc1c9276346f2f9aa7c35b`.
- Root cause: `RouteBoundAdapter` treated the mere presence of a method named `runWithResolvedExecution` as proof that an adapter could honor an exact resolved `AccessRoute`; production composition separately marked activated routes routable and product-visible without checking that execution contract.
- Cost if wrong: CMMChat can advertise a route that cannot execute the selected provider/connection/model/profile exactly, or can accidentally accept a look-alike adapter method as route support.
- RED: `npx vitest run tests/catalog/runtime-bridge.test.ts --no-file-parallelism --maxWorkers 1` failed 1/8 because an adapter exposing `runWithResolvedExecution` without an explicit capability returned `completed` instead of fail-closed `unknown_model`.
- Implementation: add first-class `ProviderExecutionCapabilities.exactResolvedRoute`; require both explicit capability and the exact execution method; declare support on the generic OpenAI-compatible adapter and deterministic scripted adapter; production composition marks unsupported routes non-routable and admin-only.
- GREEN: focused runtime bridge plus production composition/catalog wave tests pass `17/17`.
- Typecheck: PASS (`npm run typecheck`).
- Diff check: PASS (`git diff --check`).
- Primary commit: `e5012e3` (`fix(catalog): require exact route execution capability`).
- Independent review V1: FAIL — two IMPORTANT findings: (1) product visibility incorrectly followed combined `routable`, hiding exact-executable but activation-disabled routes; (2) the positive CMMChat route-binding fixture exposed the exact execution method without declaring the new capability.
- Review remediation: product visibility now follows exact-route executability independently of activation; non-allowlisted NIM routes remain product-visible but non-routable; positive HTTP fixture declares the capability explicitly.
- Review remediation verification: `tests/http/cmmchat-route-resolution.test.ts` + `tests/integration/catalog-provider-wave.test.ts` pass `9/9`.
- Review remediation commit: `d636f809e2ed9cce910c9d8b1b0e6e35245f761c` (`fix(catalog): preserve route visibility semantics`).
- Independent re-review: PASS, subsumed by the final remediation reviewer and ChatGPT independent Audit V2 source review.
- Final ruling: COMPLETE.

## R2 — subscription/dedicated adapter route-bound execution

- Finding: `MAJOR-01` dedicated adapter execution gap.
- Root cause: Codex, Claude, Antigravity, Command Code and Cavoti could execute their legacy provider/model paths but could not consume the exact connection/profile/endpoint/credential selected by the shared catalog.
- RED: `tests/catalog/dedicated-route-execution.test.ts` failed `2/2` because none of the five dedicated adapters declared the exact-route contract.
- Implementation: all five adapters now declare `exactResolvedRoute`; subscription bridges validate provider, connection kind, configured profile/runtime, execution profile and runtime authorization marker before delegating to their native path; Command Code and Cavoti additionally create route-scoped clients from the exact resolved endpoint + credential while preserving their spend acknowledgements and no-fallback rules.
- Production composition proof: added deterministic dedicated-adapter injection/ACK seams used only through `ProductionCompositionOptions`, then `tests/integration/dedicated-route-production.test.ts` executes real production-composed `route:<routeId>` paths for ChatGPT/Codex, Claude, Google/Antigravity, acknowledged Command Code and acknowledged Cavoti. Command Code/Cavoti assertions prove inference sees the route-resolved credential, not the discovery client's credential.
- Provider regressions: Command Code + Cavoti `69/69` PASS; Codex + Claude + Antigravity `253/253` PASS with PAYG fallback variables intentionally absent.
- Focused route/composition regression: `25/25` PASS across runtime bridge, dedicated contract, production-composed dedicated routes, CMMChat route resolution and production composition.
- Typecheck: PASS.
- Diff check: PASS.
- Commit: `698bafc7ea6812306cd0157721838c9d8d0b536a` (`fix(catalog): bind dedicated routes exactly`).
- Independent review: PASS, subsumed by the final remediation reviewer and ChatGPT independent Audit V2 source review.
- Final ruling: COMPLETE.

## R3–R6 final closure reconciliation

This recovery ledger was not updated while the later remediation slices were
being executed. The final repository evidence and independent Audit V2 reconcile
that gap as follows.

### R3 — live catalog reconciliation

- Finding: V1 `MAJOR-02` — shared catalog discovery was a startup snapshot.
- Implementation: Router-owned `CatalogReconciler`, per-connection discovery
  reconciliation, stable route identity, new-model appearance, removed-model
  non-routability, preserved history, and discovery-failure isolation.
- Closure commit: `7e51cd9f3b98049f76047c18987c583c705a6dd5`.
- Final ruling: COMPLETE.

### R4 — Router-owned RouteVisibility policy

- Finding: V1 `IMPORTANT-01`.
- Implementation: independent Router-owned visibility rules with server-side
  consumer enforcement; hidden routes remain present in the safe Router/Usage
  projection.
- Closure commits: `d636f809e2ed9cce910c9d8b1b0e6e35245f761c` +
  `7e51cd9f3b98049f76047c18987c583c705a6dd5`.
- Final ruling: COMPLETE.

### R5 — durable Account / ProviderProduct identity semantics

- Finding: V1 `IMPORTANT-02`.
- Implementation: resolved/unresolved account identity, stable product and
  connection topology, no synthetic provider-default Account/Product, and
  privacy-safe projections.
- Closure commit: `7e51cd9f3b98049f76047c18987c583c705a6dd5`.
- Final ruling: COMPLETE.

### R6 — closure verification

- Internal independent reviewer: PASS, Critical 0 / Important 0 / Minor 0.
- Focused remediation evidence: 12/12 files, 68/68 tests PASS.
- PAYG-contaminated failure set: 51 tests; sanitized rerun 51/51 PASS.
- Authoritative sanitized full serial: 171 files PASS + 5 skipped;
  980 tests PASS + 25 skipped; exit 0.
- Build/typecheck/security audit: PASS.
- ChatGPT independent Audit V2 on exact tree
  `e4bb2c8f6b111dd516d753b3d96cbfaac2e8a203`: technical PASS with only
  documentation/closure findings.
- Push: NO.
- Merge: NO.
- Final ruling: COMPLETE after the docs-only V2 closure commit.
