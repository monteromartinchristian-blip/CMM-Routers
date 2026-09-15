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
- Review remediation commit: PENDING.
- Independent re-review: PENDING.
- Final ruling: PENDING.
