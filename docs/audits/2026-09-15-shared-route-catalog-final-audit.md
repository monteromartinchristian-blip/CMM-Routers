# CMM Routers — Shared Route Catalog Final Audit

**Date:** 2026-09-15
**Branch:** `feature/shared-router-core`
**Verified code HEAD:** `01269dbbb774c5fdca766bbc955e271dfb2521ad`
**Plan:** `docs/superpowers/plans/2026-09-15-cmm-routers-shared-core-route-catalog-implementation-plan.md`

This audit closes the shared Router catalog and CMMChat route-execution plan on
deterministic evidence only. No live provider inference or administrative call
was performed. No push or merge was performed.

## Verification evidence

- Focused catalog/CMMChat/Usage-boundary gate: **12/12 files PASS, 83/83 tests PASS**.
- Provider/consumer regression gate: **82/82 files PASS, 486/486 tests PASS**.
  The host inherited `OPENAI_API_KEY`; the repository's intentional PAYG guard
  correctly rejected that environment. Re-running with the forbidden ambient
  PAYG variables removed from the test process passed without code changes.
- Build: `npm run build` **PASS**.
- Typecheck: `npm run typecheck` **PASS**.
- Security audit: `bash scripts/security-audit.sh` **PASS**.
- Diff check: `git diff --check` **PASS** before this documentation-only audit.
- Full serial gate with ambient PAYG variables removed from the test process:
  **166 files PASS, 5 skipped; 959 tests PASS, 25 skipped; exit 0**.
  The skipped tests are the repository's intentional live-provider/live-mutation
  gates. The run completed in 502.48 s.
- Host inspection before the full serial found no CMM Usage runtime, parallel
  Hermes build, AutoClaw deep scan, or other heavy harness job. Existing Hermes
  gateway/AutoClaw/Codex processes were idle or low-load and did not produce
  migrating timeouts or resource-pressure failures.

## Final invariant review

- The diff since `6ad5807` contains no CMM Usage frontend/runtime implementation.
- `AccessRoute.routeId` remains the exact executable identity. CMMChat accepts
  explicit catalog selection only as `model: "route:<routeId>"`; ordinary model
  selectors stay on the legacy registry path.
- Route visibility is enforced server-side before execution. Hidden routes remain
  visible to the read-only Usage/admin projection but cannot execute through
  CMMChat.
- Execution authorization and observability authorization are separate. The
  adversarial boundary tests prove an observability-only credential cannot make a
  route executable, even when it references the same physical secret.
- Explicit route execution stays bound to the selected provider, connection,
  provider model, credential, endpoint, and execution profile. An adapter that
  cannot consume the resolved binding fails closed.
- The OpenAI-compatible legacy `run()` path is preserved through the same
  `runWithClient()` behavior; route-bound execution adds an isolated resolved
  client rather than replacing ordinary provider semantics.
- Catalog projection is built from the current canonical stores on each request.
  It exposes no raw secret, `secretRef`, credential binding ID, profile path/ref,
  endpoint ref, external account ref, access token, or auth blob.
- Provider IDs remain the existing provider-wave IDs; Qwen Token Plan and Qwen
  Cloud remain distinct executable routes even when they map to one canonical
  model identity.
- No silent PAYG fallback, provider fallback, or cross-provider fallback exists in
  the catalog execution path.
- REAL STATE > FIXTURES remains enforced: no demo/fixture provider identity is
  synthesized into Router truth or accepted from the Usage projection.

## Publication/privacy late finding

The late Task 1 publication/privacy regression was remediated separately in
`aff2d92` (`fix(test): avoid vendor-shaped secret fixtures`). The root cause was
test-only `sk-...` literals matching the intentional `openai-style-token` BLOCK
rule. The remediation changed fixture values only; the privacy scanner was not
weakened. Post-fix public-candidate scan: **0 findings / 0 blockers / PASS**.
Independent scoped review: **SPEC/INTENT PASS, CODE/TEST PASS, Critical 0,
Important 0, Minor 0**.

## Task 11 independent review

The previously quota-blocked review of `866e6db` completed on the current tree:
**SPEC PASS, QUALITY PASS, Critical 0, Important 0, Minor 0**. The reviewer
verified bearer-auth reuse, GET-only semantics, live canonical projection,
hidden-route retention for Usage/admin, secret/internal-field exclusion, and
production composition wiring.

## Acceptance markers

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
