# CMM Routers — Shared Core Remediation Ledger

**Date:** 2026-09-16  
**Branch:** `feature/shared-router-core`  
**Audit input:** `docs/audits/2026-09-15-independent-shared-core-audit-v1-679778eba41f.md`  
**Remediation start HEAD:** `698bafc7ea6812306cd0157721838c9d8d0b536a`

This ledger records the narrow R1–R6 remediation of the independent shared-core
audit. It preserves prior history and records deterministic verification only.
No push or merge is part of this closure.

## Finding → remediation mapping

| Audit finding | Remediation | Commit / closure |
| --- | --- | --- |
| MAJOR-01 — executable-route capability truth | R1 — require explicit exact resolved-route execution capability before advertising a route as routable | `e5012e3` (`fix(catalog): require exact route execution capability`) |
| MAJOR-02 — dedicated/subscription routes could be advertised without exact route-bound execution | R2 — bind Codex, Claude, Antigravity, Command Code and Cavoti to the resolved route contract and remove whole-adapter/test-only bypass seams | `698bafc` (`fix(catalog): bind dedicated routes exactly`) |
| IMPORTANT-01 — catalog truth could become stale and visibility was coupled to adapter capability | R3/R4 — live catalog reconciliation plus Router-owned visibility policy | final remediation commit created from this ledger closure |
| IMPORTANT-02 — synthetic per-provider Account / ProviderProduct defaults | R5 — durable resolved/unresolved account identity, explicit product/connection topology, at most one primary runtime connection, secondary connections represented disabled | final remediation commit created from this ledger closure |
| R6 — independent re-audit + final deterministic gates | Independent reviewer PASS plus focused/full serial/build/typecheck/security/diff gates | final remediation commit created from this ledger closure |

## R6 independent reviewer verdict

Independent read-only re-audit of the remediation tree returned:

```text
VERDICT=PASS
CRITICAL=0
IMPORTANT=0
MINOR=0
FOCUSED_REMEDIATION_FILES=12/12 PASS
FOCUSED_REMEDIATION_TESTS=68/68 PASS
TYPECHECK=PASS
DIFF_CHECK=PASS
```

The reviewer explicitly verified R1–R5, including disabled-secondary
reconciliation, Router-owned visibility, resolved identity derived from
`providerId + externalAccountRef`, distinct unresolved identity semantics,
product/connection stable IDs, schema referential integrity, and projection
privacy.

## PAYG environment contamination incident

The first broad regression/full-suite attempt inherited `OPENAI_API_KEY` from
the host environment. The repository's intentional PAYG guard therefore failed
closed. The apparent provider/bootstrap failures were environment contamination,
not remediation regressions.

The same previously failing set was rerun with the forbidden ambient PAYG
variables removed from the test process:

```text
OPENAI_API_KEY=UNSET_FOR_TEST_PROCESS
ANTHROPIC_API_KEY=UNSET_FOR_TEST_PROCESS
GEMINI_API_KEY=UNSET_FOR_TEST_PROCESS
GOOGLE_API_KEY=UNSET_FOR_TEST_PROCESS
PREVIOUSLY_FAILING_FILES=10/10 PASS
PREVIOUSLY_FAILING_TESTS=51/51 PASS
```

The authoritative sanitized full serial suite then completed with exit code 0:

```text
FULL_SERIAL_SUITE=PASS
TEST_FILES_PASS=171
TEST_FILES_SKIPPED=5
TEST_FILES_TOTAL=176
TESTS_PASS=980
TESTS_SKIPPED=25
TESTS_TOTAL=1005
EXIT_CODE=0
```

The stderr lines emitted by negative-path preflight/launchd tests are expected
fixture behavior; the suite result above is authoritative.

## Closure constraints

```text
PUSH=NO
MERGE=NO
MERGE_READY=NO_PENDING_CHATGPT_INDEPENDENT_V2_AUDIT
```

