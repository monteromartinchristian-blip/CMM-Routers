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
- Commit: PENDING.
- Independent review: PENDING.
- Final ruling: PENDING.
