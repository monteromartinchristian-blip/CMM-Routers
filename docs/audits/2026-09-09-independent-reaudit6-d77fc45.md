# CMM Subscription Router — Independent Human Re-audit 6

**Date:** 2026-09-09
**Audited HEAD:** `d77fc45ae2294c584c4c3a130bad8102b00a8f51`
**Scope:** Targeted Remediation 6 — Codex protocol/lifecycle, shared config validation, launchd fail-closed behavior.

## Executive verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT_6=PASS
AUDITED_HEAD=d77fc45ae2294c584c4c3a130bad8102b00a8f51
INTEGRITY=PASS
REMEDIATION_6_TARGETED_DELTA=PASS
REGRESSION_SIGNAL=STRONG
LIVE_CHAT_ACCEPTANCE_AUTHORIZED=YES
FINAL_CLOSURE_ELIGIBLE=NO
TASK_13_ORIGINAL_DOD=NOT_MET
NEXT=MINIMAL_LIVE_ACCEPTANCE
```

Remediation 6 closes the findings that triggered it. No false-positive blocker was found in the targeted delta. The Router is structurally ready for a minimal credentialed/live **chat-only** acceptance round.

Final v1 closure is not yet eligible because Task 13/tool round-trip remains intentionally unmet, launchctl/iMac proof is still pending, and two non-live-blocking runtime hardening findings are documented below.

## Integrity

Uploaded bundle SHA-256:

`7368efc048c6855cc979ee34a871a2c1f57985e5787222eb858806f01dfca516`

Uploaded verification log SHA-256:

`39fbe63ef8f9423a5c983479b8c4642a9885ca6fd6b520ebe72c142961080aeb`

`gzip -t` passed. `git get-tar-commit-id` over the uploaded archive returned:

`d77fc45ae2294c584c4c3a130bad8102b00a8f51`

Therefore the code inspected is the exact audited commit.

## Verification signal

The supplied verification log records three full green test runs plus a green post-build rerun:

```text
Test Files 67 passed | 5 skipped (72)
Tests      399 passed | 25 skipped (424)
TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
```

The explicit targeted suites also passed:

```text
TARGETED_CODEX_RC=0
TARGETED_PREFLIGHT_RC=0
TARGETED_LAUNCHD_RC=0
ACTUAL_DIST_PROCESS_RC=0
SOCKET_DISCONNECT_RC=0
```

PAYG poison probes correctly failed closed:

```text
OPENAI_PAYG_POISON_RC=1
ANTHROPIC_PAYG_POISON_RC=1
GOOGLE_PAYG_POISON_RC=1
```

The `dirname` / `sed` / `head` "command not found" lines seen during `preflight-matrix.test.ts` are produced by the deliberate node-absent fixture whose PATH contains only the fake test directory. They are confined to the negative test; the suite correctly asserts non-zero fail-closed behavior. They are not a normal-runtime failure.

## Finding closure

### 1. Canonical Codex history method — PASS

Production now uses:

`thread/inject_items`

`src/providers/codex/app-server-client.ts` exposes `INJECT_ITEMS_METHOD = "thread/inject_items"`, and `CodexAdapter` invokes that method for history injection.

The generated `ClientRequest.json` discriminator also contains `thread/inject_items`; stale `thread/injectItems` occurs only in negative assertions/tests and audit prose.

```text
CODEX_THREAD_INJECT_ITEMS_WIRE=PASS
CODEX_STALE_INJECTITEMS_METHOD=ABSENT_IN_PRODUCTION
```

### 2. Schema provenance / drift guard — PASS

The committed provenance records Codex CLI `0.153.4` and a schema refresh command using `codex app-server generate-json-schema`. The tracked generated schema contains the canonical request discriminators used by production.

The drift guard now validates both payload shapes and method names, including a negative assertion for `thread/injectItems`.

```text
CODEX_PROTOCOL_METHOD_DRIFT_GUARD=PASS
CODEX_PROTOCOL_PAYLOAD_DRIFT_GUARD=PASS
CODEX_PROTOCOL_DRIFT_GUARD=PASS
```

The independent environment cannot rerun the user's installed Codex binary, so byte-identity with the installed binary is supported by the captured provenance rather than independently regenerated here. This is acceptable for the live gate because the actual installed version was captured as `codex-cli 0.153.4` and production methods match the committed generated schema.

### 3. Malformed Codex stdout — PASS

`CodexAppServerClient.handleMessage()` now converts non-empty malformed JSON-RPC frames into `provider_protocol_error` through `failProtocol()` rather than silently ignoring them.

Raw malformed content is not embedded in the error or logged.

Adapter-level tests prove an active run terminates and `activeTurns` is cleaned.

```text
CODEX_MALFORMED_STDOUT=PROVIDER_PROTOCOL_ERROR
CODEX_MALFORMED_REQUEST_CLEANUP=PASS
CODEX_MALFORMED_CONTENT_LOGGING=NONE
```

A malformed frame invalidates active scoped runs on that shared app-server connection. That is an appropriately fail-closed choice for an uncorrelatable transport corruption.

### 4. Notification lifecycle — PASS

The old unbounded process-lifetime notification retention has been removed.

Production now:

- buffers only the small supported notification set;
- bounds the buffer to 64 entries;
- drops known ignorable content-bearing events immediately;
- drops unknown/unawaited events without retaining payloads;
- purges scope on completion/cancel/error teardown;
- clears state on stop.

The tests exercise a large unmatched notification flood and stale-content isolation.

```text
CODEX_UNMATCHED_NOTIFICATION_RETENTION=BOUNDED_OR_NONE
CODEX_NOTIFICATION_QUEUE_UNBOUNDED=NO
CODEX_UNBOUNDED_CONTENT_RETENTION=NONE
CODEX_STALE_NOTIFICATION_REDELIVERY=NONE
CODEX_CROSS_REQUEST_CONTENT_LEAK=NONE
```

### 5. Concurrent cancellation A/B — PASS

`tests/providers/codex-concurrent-cancel.test.ts` drives two simultaneous production `CodexAdapter` runs over the real dispatcher/client implementation.

A is cancelled at `thread-A/turn-A`; B continues receiving `B3` and completes. A has no completion event and leaves no active turn, waiter or buffered notification behind.

```text
CODEX_CANCEL_A_TARGET_THREAD=thread-A
CODEX_CANCEL_A_TARGET_TURN=turn-A
CODEX_REQUEST_B_CONTINUES=YES
CODEX_REQUEST_B_COMPLETES=YES
CODEX_CANCEL_AFFECTED_B=NO
CODEX_CANCEL_SCOPING=PASS
CODEX_CANCEL_A_STATE_CLEANUP=PASS
```

### 6. Preflight / production schema equivalence — PASS

`scripts/validate-config.mjs` imports the same `sharedConfigSchema` and `localConfigSchema` used by production. `preflight.sh` no longer contains an independent JSON schema.

The equivalence suite covers malformed JSON and valid JSON that violates production Zod constraints, including missing mode, invalid host/port/provider structure and invalid provider path/env types.

```text
PREFLIGHT_PRODUCTION_SCHEMA_EQUIVALENCE=PASS
PREFLIGHT_DUPLICATE_CONFIG_SCHEMA=NONE
```

### 7. launchd fail-closed executable resolution — PASS for requested delta

`scripts/macos/install-router.sh` now requires executable absolute paths for Node and enabled local provider binaries, and refuses installation if they cannot be resolved.

The plist receives absolute `CMM_ROUTER_NODE_BIN`, `CMM_ROUTER_CODEX_BIN`, `CMM_ROUTER_AGY_BIN`, and a bounded safe PATH. Invalid shared config also aborts installation.

```text
LAUNCHD_MISSING_NODE=FAIL_CLOSED
LAUNCHD_MISSING_CODEX_WHEN_ENABLED=FAIL_CLOSED
LAUNCHD_MISSING_AGY_WHEN_ENABLED=FAIL_CLOSED
LAUNCHD_DISABLED_PROVIDER_BINARY_NOT_REQUIRED=PASS
LAUNCHD_BARE_NODE_FALLBACK=NONE
LAUNCHD_BARE_CODEX_FALLBACK=NONE
```

## Regression checks

Previously closed areas remain green in the supplied verification:

```text
CLAUDE_TRUE_INCREMENTAL_STREAMING=PASS
CLAUDE_CONVERSATION_SEMANTICS=PASS
CLAUDE_PROFILE_ISOLATION=PASS
ANTIGRAVITY_TRUE_INCREMENTAL_STREAMING=PASS
ANTIGRAVITY_CONVERSATION_SEMANTICS=PASS
ANTIGRAVITY_TEMP_CLEANUP=PASS
COMMAND_CODE_NATIVE_BODY_ABORT=PASS
CHAT_ONLY_TOOL_ENFORCEMENT=PASS
FRESH_CLONE_BOOTSTRAP=PASS
ACTUAL_DIST_PROCESS=PASS
REAL_SOCKET_DISCONNECT=PASS
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
```

## Non-live-blocking findings for final closure

### H1 — Codex child-process supervision remains incomplete

`CodexAdapter.ensureStarted()` spawns `codex app-server --stdio`, but production does not currently attach child `exit` / `close` / `error` lifecycle handlers that invalidate the adapter client, reject live waits with a provider error, and permit a clean restart on a later request.

The current client has a stream-error rejection path, but the real child stdout is manually forwarded into an intermediate `Duplex`; child exit/close is not forwarded into that client stream. Therefore an unexpected `codex app-server` death can leave the adapter holding a non-null dead client until timeout/restart.

This does **not** prevent a normal healthy live acceptance run, so it is not a blocker for the next phase. It should be closed before declaring the Router production/finally complete because the design explicitly says to supervise app-server and the v1 criteria require surviving provider failure.

Recommended post-live hardening:

```text
CODEX_CHILD_EXIT_PROPAGATION
CODEX_CLIENT_INVALIDATION_ON_EXIT
CODEX_NEXT_REQUEST_RESTART
CODEX_PENDING_RUN_FAILURE_MAPPING
```

### H2 — launchd-resolved default Antigravity path is not consumed by production

The installer may resolve `agy` to an arbitrary executable absolute path and writes it into the plist as `CMM_ROUTER_AGY_BIN`.

However, when `providers.google.agyPath` is absent, production constructs `AntigravityAdapter` with no path override; its default is the compile-time `AGY_PATH = ~/.local/bin/agy`. No production Antigravity source reads `CMM_ROUTER_AGY_BIN`.

Thus a machine where `agy` is installed at (for example) `/opt/homebrew/bin/agy` but not `~/.local/bin/agy` can pass installer resolution yet launch the Router with the wrong Antigravity executable path.

This does not block current MacBook live acceptance if the default `~/.local/bin/agy` path is actually present (the captured preflight reports the default route as available), but it must be fixed before claiming fully reproducible iMac/launchd installation.

Recommended final Task 17 hardening: production resolution should be:

```text
config.providers.google.agyPath
→ CMM_ROUTER_AGY_BIN
→ documented default
```

or the installer should write the resolved path into an authoritative local config consumed by production.

## Task 13 remains unchanged

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=chatgpt/CHAT_ONLY claude/CHAT_ONLY google/CHAT_ONLY command-code/CHAT_ONLY
```

This is intentional and truthful. The Router's HTTP boundary correctly rejects tool semantics for current CHAT_ONLY providers instead of silently stripping or forwarding them.

Therefore the upcoming live acceptance is a **chat-only provider acceptance**, not proof of Qoder Agent/tool-loop completion.

## Live gate decision

The structural blockers that previously made credentialed testing wasteful are now closed. Minimal live provider testing is justified.

```text
LIVE_CHAT_ACCEPTANCE_AUTHORIZED=YES
LIVE_TOOL_ACCEPTANCE_AUTHORIZED=NO
```

Live scope should be intentionally small:

1. ChatGPT/Codex subscription: model discovery + one short single-turn completion + one multi-turn/history completion + cancellation/usage observation.
2. Claude subscription: one short completion and one multi-turn/history check using the isolated Router profile.
3. Antigravity/Google account: one short completion and one multi-turn/history check.
4. Command Code GOAT: one short completion using the already-proven plan secret, with spend guard active and no extra/on-demand fallback.
5. Qoder: models visible through `127.0.0.1:8790/v1`, one ordinary chat request per provider; no tool payloads yet.

Do not expand prompts, loop stress tests, or consume unnecessary quota.

## Final status

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT_6=PASS
AUDITED_HEAD=d77fc45ae2294c584c4c3a130bad8102b00a8f51
INTEGRITY=PASS
REMEDIATION_6_TARGETED_DELTA=PASS
REGRESSION_SIGNAL=STRONG

CODEX_PROTOCOL_CONFORMANCE=PASS
CODEX_MALFORMED_FRAME_HANDLING=PASS
CODEX_NOTIFICATION_LIFECYCLE=PASS
CODEX_CONCURRENT_CANCEL_ISOLATION=PASS
PREFLIGHT_SCHEMA_EQUIVALENCE=PASS
LAUNCHD_FAIL_CLOSED_DELTA=PASS

LIVE_CHAT_ACCEPTANCE_AUTHORIZED=YES
LIVE_TOOL_ACCEPTANCE_AUTHORIZED=NO

TASK_13_ORIGINAL_DOD=NOT_MET
LAUNCHD_RUNTIME_SMOKE=BLOCKED_TEST_ENVIRONMENT
IMAC_INSTALL=PENDING

NONBLOCKING_HARDENING:
- Codex child-process supervision/restart
- launchd-resolved default Antigravity path propagation

FINAL_CLOSURE_ELIGIBLE=NO
NEXT=MINIMAL_LIVE_ACCEPTANCE
```
