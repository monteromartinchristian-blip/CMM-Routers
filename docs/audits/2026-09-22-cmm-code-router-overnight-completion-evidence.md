# CMM Code Router — Overnight Completion Evidence (Phases 3 → 7)

**Date:** 2026-09-22
**Branch:** `feature/cmm-code-router-client-agnostic`
**Nature:** Implementation/verification evidence for this run. Historical audit
documents are **not** rewritten by this work; new documents were added and
existing ones left byte-identical.

## 1. Starting and ending revisions

- **Starting HEAD:** `373262d989a2ab999e82a885a5281ffe0e5b5249` (Phase 2 closed)
- **Ending HEAD of code + verification work:** `ccfbdcc5c4d7fe188abddf6ea42995b35a4222b6`
- The per-phase evidence documents (including this one) are added in a final
  docs-only commit; that commit's SHA is reported in the run's final response.

Working tree was clean at the start and at every phase boundary.

## 2. Commits by phase

### Phase 3 — Broker / provider neutrality

| Commit | Subject |
|---|---|
| `74f4172` | `refactor: make the deferred tool broker client-neutral` |
| `07e0bb1` | `refactor: neutralize provider/bridge execution-owner wording` |
| `173c114` | `test: assert provider neutrality by architecture, and fix the wire provider list` |
| `2e5818a` | `docs: record Phase 3 broker/provider neutrality evidence` |

### Phase 4 — Client compatibility

| Commit | Subject |
|---|---|
| `106ae8f` | `feat: record profile and client identity in usage diagnostics` |
| `44b522b` | `test: prove Qoder, Hermes and Codex-client compatibility contracts` |
| `987ab5b` | `docs: document client compatibility mechanisms and real-client status` |

### Phase 5 — Documentation / install / migration

| Commit | Subject |
|---|---|
| `23bc3ee` | `feat: wire the canonical Code Router bearer into the install path` |
| `cc9cd37` | `docs: document canonical bearer provisioning, migration and truthful status` |

### Phase 6 — Verification / hardening

| Commit | Subject |
|---|---|
| `f3e4f67` | `test: recover the compiled-process Code Router E2E with exact test-only injection` |
| `c60075e` | `test: repair the vacuous capability test and reconcile the Codex record` |

### Phase 7 — Real-client gates

| Commit | Subject |
|---|---|
| `ae0ab9e` | `feat: normalize the Responses boundary for real client request shapes` |
| `ccfbdcc` | `test: let the scripted tool double also answer plain chat` |

## 3. Files changed by phase

| Phase | Files changed |
|---|---|
| Phase 3 | 24 |
| Phase 4 | 9 |
| Phase 5 | 9 |
| Phase 6 + 7 | 9 |
| **Total (range 373262d..ccfbdcc)** | **46** |

No file outside `src/`, `tests/`, `scripts/`, `docs/`, `launchd/`, `README.md`
and `.env.example` was touched.

## 4. Gates run

| Gate | Result |
|---|---|
| Phase 1 focused (profile/auth) | PASS |
| Phase 2 generic protocol | PASS |
| Phase 3 broker/provider-neutrality | PASS |
| Phase 4 client-compatibility deterministic | PASS |
| Install/auth tests | PASS |
| Broker adversarial / concurrency / cancellation | PASS |
| Provider suites (`tests/bridge` + `tests/providers` + `tests/core`) | PASS (78 files / 453 tests) |
| Compiled-process E2E | PASS (4) |
| Target: typecheck | PASS |
| Target: build | PASS |
| Target: `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| Target: `git diff --check` | clean |
| Full suite | 9 failed files / 21 failed / **875 passed** / 25 skipped (921) |

### Full-suite failure classification (evidence, not assertion)

All failing files belong to the pre-existing environmental family, and each was
verified rather than assumed:

| File | Cause | Evidence |
|---|---|---|
| `launchd-deterministic`, `launchd-fail-closed` | installer cannot resolve `codex`/`agy` on this machine | fails identically on the untouched baseline |
| `preflight-config`, `preflight-failclosed`, `preflight-matrix` | `scripts/preflight.sh` provider probes; 5 s timeouts under load | pass in isolation (5/5 for config+failclosed); the test files and `scripts/preflight.sh` are byte-identical to the baseline; `preflight.sh` does not invoke the modified audit script |
| `antigravity-mcp-cli-bounds` | load-sensitive `max_buffer` vs `timeout` assertion | passes 6/6 in isolation on both baseline and this HEAD |
| `claude-adapter` | 5 s timeout spawning the SDK/bridge | fails identically on the untouched baseline |
| `prepare-publication`, `push-publication`, `verify-publication` | git/remote publication infrastructure | fails identically on the untouched baseline |

Earlier in the run, `preflight.test` and `preflight-malformed` failed with 5 s
timeouts and then passed in both isolation and a later full run — recorded as
load flakiness, not a regression. No timeout was raised, no test was skipped or
weakened, and no failing assertion was deleted to obtain green output.

## 5. Real-client / live classification

| Gate | Classification |
|---|---|
| `GENERIC_OPENAI_CODE_ROUTER` | **PASS** (architectural reference client, deterministic + compiled-process) |
| `QODER_CODE_ROUTER` | **BLOCKED_MANUAL_UI** (provider absent; registration needs the Qoder UI) |
| `HERMES_CODE_ROUTER` | **MANUAL_PENDING** (mechanism verified; live turn not run for safety) |
| `CODEX_CLIENT_CODE_ROUTER` | **BLOCKED_CLIENT_LIMITATION** (Router cannot represent `namespace`/hosted tool declarations) |
| Google/GPT-OSS, Sonnet, ChatGPT/Codex revalidation | **BLOCKED_QUOTA / not attempted** |
| Command Code live | **BLOCKED_DISABLED** |
| Task 16B multi-Mac | **BLOCKED** (depends on unimplemented richer `x_cmm`) |

No gate was marked PASS from mocked traffic, and no blocked gate is reported as a
Router failure.

## 6. Live requests actually performed

| Client | Invocation | Destination | Quota |
|---|---|---|---|
| Codex CLI 0.147.0 | real `codex exec` turn | local CMM Router running the `scripted-tools` double | **none** |
| Codex CLI 0.147.0 | real `codex exec` turn | local request-capture probe (no model backend) | **none** |
| Codex CLI 0.147.0 | `codex exec --help` | n/a | none |

No Hermes or Qoder model turn was executed. No external provider was contacted
for inference. **PAYG_USED=NO.** No secret value was printed, captured, or
committed; captured request headers were redacted before inspection.

## 7. Blockers

1. **Qoder registration requires the Qoder UI** — no CLI path exists; the
   documented `qoder-custom-cmm-router` provider is absent locally.
2. **Codex CLI tool declarations** — 18 of 31 declared tools are grouped
   `namespace` entries and one is a provider-hosted `web_search`; representing
   them faithfully is a design decision, and dropping them is forbidden.
3. **Hermes live turn** — no verified config-path override, so the live agent
   config was not edited; the exact manual step is documented.
4. **Task 16 / 16B** — richer `x_cmm`/`runtimeCapabilities` is unimplemented.
5. **Provider live gates** — quota, disabled providers, or PAYG risk.

## 8. Legacy identifiers preserved

Unchanged and asserted by the audit
(`PERSISTED_LEGACY_NAMES_PRESERVED=YES`,
`LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO`):

```text
CMM_QODER_TOKEN          qoder-bearer
cmm-qoder-tools          mcp(cmm-qoder-tools/*)
cmm_qoder                mcp__cmm_qoder__
qoder-custom-cmm-router  QODER_SMOKE_OK
com.cmm.subscription-router  cmm-subscription-router
```

`QODER_SMOKE_OK` was deliberately left untouched (it is in the frozen list), so
the planned "test-double marker neutrality" item was dropped rather than
violated.

## 9. Security invariant summary

```text
CMMCHAT_CHAT_ONLY=PASS
CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS
CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
LOOPBACK_ONLY=YES
TRACKED_SECRETS=NONE
AMBIGUOUS_AUTH_FAILS_CLOSED=PASS
BROKER_CLIENT_NEUTRAL=PASS
BROKER_CORRELATION_ISOLATION=PASS
ANTIGRAVITY_SCOPED_MCP_ACL_PRESERVED=PASS
TEST_PROVIDER_INJECTION_EXACT=PASS
COMPILED_PROCESS_CODE_ROUTER_E2E=PASS
SECURITY_AUDIT=PASS
```

## 10. Publication / repository state

```text
PUSH_PERFORMED=NO
MERGE_PERFORMED=NO
PUBLICATION_PERFORMED=NO
TAG_CREATED=NO
PR_CREATED=NO
```

No other worktree was touched. The pre-existing Router process on port 8790 was
left untouched; all processes started for the live gates were stopped and their
ports are free. The CMM Routers Console was not touched. No PAYG provider was
enabled, no billing policy was changed, and no provider account was enabled to
obtain a pass.
