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
| MAJOR-01 — executable-route truth, including dedicated adapter exact execution | R1/R2 — explicit exact-route capability plus exact route-bound execution for Codex, Claude, Antigravity, Command Code and Cavoti | `e5012e3` + `d636f80` + `698bafc` |
| MAJOR-02 — shared catalog was a startup snapshot | R3 — live per-connection catalog reconciliation, stable route identity, removed-model unavailability and failure isolation | `7e51cd9` |
| IMPORTANT-01 — no real Router-owned production RouteVisibility policy | R4 — Router-owned visibility policy independent from routability/Usage/billing | `d636f80` + `7e51cd9` |
| IMPORTANT-02 — synthetic per-provider Account / ProviderProduct defaults | R5 — resolved/unresolved account identity plus explicit product/connection topology without fake defaults | `7e51cd9` |
| R6 — independent re-audit + final deterministic gates | Internal reviewer PASS, sanitized full serial PASS, and ChatGPT independent V2 technical PASS | `7e51cd9` + docs-only V2 closure commit |

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
