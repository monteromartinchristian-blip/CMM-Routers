# Task 13 — Canary & Antigravity Registration Correctness (Implementation Plan)

**Date:** 2026-09-10
**Design:** `docs/superpowers/specs/2026-09-10-task13-canary-registration-correctness-design.md`
**START_HEAD:** `6341e0fc6f36d2933429d524f60d601f5c1deb7a`
**Rule:** TDD — RED (observed failure) → minimal GREEN → adjacent regression →
focused commit. No assertion is weakened to obtain GREEN.

## Commit order (adjust only for real dependencies)

1. `docs: design Task 13 canary and registration correctness`
2. `docs: plan Task 13 canary and registration correctness`
3. `fix: canonicalize Antigravity MCP registration without hidden env` (D1)
4. `fix: validate Antigravity MCP transport and bound CLI operations` (D1b,D2)
5. `fix: make Antigravity byte limits UTF-8 exact` (D3)
6. `fix: publish Antigravity session descriptors atomically` (D4)
7. `fix: authenticate live canaries as Qoder` (D5)
8. `fix: make canary payloads provider-specific` (D6)
9. `feat: make live canary prove Qoder tool-result continuation` (D7,D9,D10)
10. `test: make canary exits and model selection fail closed` (D8,D9)
11. `test: prove canary harness against local fake Router` (P1 #12)
12. `tooling: make audit capture byte-verifiable` (D11)
13. `security: audit final acceptance boundary`
14. `docs: add Task 13 canary and registration correctness evidence`

## T1 — Registration hidden-env + stdio type (D1, D1b)

Files: `src/providers/antigravity/mcp-registration.ts`,
`tests/providers/antigravity-mcp-registration.test.ts`.

RED: extend `FakeAgy` so a seeded entry can be visible-canonical but carry a
hidden `env` that `render()` does not print. Test: seed `type=stdio`,
`command/args` correct, `enabled`, hidden `OLD_SESSION_SECRET=CANARY`; first
`ensure` in a fresh process must NOT be a noop; after it, the hidden env is gone
and the visible state is canonical. Separately, a `type=sse` entry must not be
accepted as canonical.

GREEN: unconditional per-process canonical rewrite (`canonicalized` action),
process marker keyed by `serverName+command+args`, `type==="stdio"` required.
Export a test-only `resetAntigravityMcpRegistrationProcessState()`.

Markers: `ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS`,
`ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_BY_CONSTRUCTION=PASS`,
`ANTIGRAVITY_MCP_NEW_PROCESS_CANONICALIZATION=PASS`,
`ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS`.

## T2 — Bound agy MCP CLI operations (D2)

Files: `mcp-registration.ts`, new `tests/helpers/fake-agy-cli.js`,
`tests/providers/antigravity-mcp-cli-bounds.test.ts`.

RED: fake CLI fixture modes `hang` / `oversize-stdout` / `oversize-stderr` /
`exit-nonzero` / `argv-echo`. Pre-fix `execFileAgyRunner` has no timeout/maxBuffer
so `hang` blocks (test timeout) and `oversize-*` is not bounded.

GREEN: `execFileAgyRunner(agyPath, { timeoutMs, maxBufferBytes })` with finite
defaults; timeout/overflow/signal/nonzero => bounded fail-closed
`provider_unavailable`; argv passed literally (no shell).

Markers: `ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS`,
`ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS`,
`ANTIGRAVITY_MCP_CLI_FAILURE_FAIL_CLOSED=PASS`,
`ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS`.

## T3 — UTF-8 byte-true agy limits (D3)

Files: `src/providers/antigravity/process-client.ts`,
`tests/providers/antigravity-byte-limits.test.ts`.

RED: multibyte string of N chars, `Buffer.byteLength` > 2N; `.length` bound holds
but byte bound is violated (assert byte length of retained value <= cap).

GREEN: `Buffer.byteLength` checks + byte-aware head/tail truncation that never
splits a UTF-8 sequence.

Markers: `AGY_STDOUT_UTF8_BYTE_BOUND=PASS`, `AGY_STDERR_UTF8_BYTE_BOUND=PASS`,
`AGY_NDJSON_UTF8_BYTE_BOUND=PASS`, `AGY_DIAGNOSTIC_MEMORY_REMAINS_BOUNDED=PASS`.

## T4 — Atomic descriptor publication (D4)

Files: `src/bridge/session-registry.ts`,
`tests/bridge/session-registry-atomic.test.ts`.

RED: a reader/reconciler loop that parses `agy-<pid>.json` during publication
observes partial JSON with the in-place writer.

GREEN: temp file (mode 0600, unique name) → complete JSON write → `renameSync`
to the final path; abandoned temp files cleaned when safe; verified-live
descriptors never overwritten.

Markers: `SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS`,
`SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO`, `SESSION_DESCRIPTOR_MODE_0600=PASS`.

## T5 — Canary auth as Qoder (D5)

Files: `scripts/live-canary/canary-lib.sh` (+ wrappers), deterministic tests
under `tests/live-canary/`.

RED: canary-lib reads `CMM_ROUTER_TOKEN`; a fake-Router test shows the wrong
consumer.

GREEN: read `CMM_QODER_TOKEN` else Keychain (`security find-generic-password`,
same service/account contract as `scripts/macos/run-router.sh`); preflight
resolves consumer=QODER + capability=CHAT_AND_TOOLS else exit 2; never falls back
to `CMM_ROUTER_TOKEN`; token never printed.

Markers: `LIVE_CANARY_AUTH_CONSUMER=QODER`,
`LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS`, `LIVE_CANARY_CMMCHAT_BEARER_USED=NO`.

## T6 — Provider-specific policy + full round-trip (D6, D7, D9, D10)

Files: `scripts/live-canary/canary-lib.sh`, wrappers, `tests/live-canary/`
fake-Router suite (Node fake Router on loopback: /v1/models, /v1/chat/completions).

Deterministic tests cover: Qoder auth success, CMMChat rejection, missing bearer,
wrong model, multiple models, no tool call, wrong tool, malformed args, correct
tool request, correct continuation, wrong continuation id, final unrelated, final
derived, Router 401/429/500, blocked prerequisite, provider-specific policy
bodies.

Markers: `CLAUDE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC`,
`GOOGLE_...`, `CODEX_...`, `COMMAND_CODE_...`,
`LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES`,
`LIVE_CANARY_TOOL_NAME=canary_echo`,
`LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES`,
`LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES`,
`LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES`,
`LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES`,
`LIVE_CANARY_FULL_ROUNDTRIP=PASS`,
`LIVE_CANARY_HARNESS_DETERMINISTIC_TESTS=PASS`,
`LIVE_CANARY_PAYG_POISON=PASS`,
`LIVE_CANARY_NO_PROVIDER_NATIVE_TOOL=PASS`,
`LIVE_CANARY_NO_REPO_MUTATION=PASS`.

## T7 — Exit codes + exact model selection (D8, D9)

Shell-level: `canary_blocked` → exit 2; FAIL → exit 1; PASS → 0. Deterministic
shell/mock tests assert the codes. `CMM_LIVE_CANARY_MODEL` exact selection with no
fallback; ambiguity => exit 2.

Markers: `LIVE_CANARY_PASS_EXIT=0`, `LIVE_CANARY_FAIL_EXIT_NONZERO=PASS`,
`LIVE_CANARY_BLOCKED_EXIT_NONZERO=PASS`, `LIVE_CANARY_EXACT_MODEL_SELECTION=PASS`,
`LIVE_CANARY_MODEL_FALLBACK=NONE`.

## T8 — Capture byte-identity (D11)

Files: new `scripts/capture-bundle.sh`, self-test fixture.

Build archive → close log → hash FINAL archive + FINAL log → write SEPARATE
manifest → `shasum -a 256 -c manifest` PASS.

Markers: `CAPTURE_BUNDLE_BYTE_IDENTITY=PASS`, `CAPTURE_LOG_BYTE_IDENTITY=PASS`,
`CAPTURE_SHA256_MANIFEST_VERIFY=PASS`.

## T9 — Final gate + evidence

`npm test` ×3, `npm run typecheck`, `npm run build`, `npm test` (post-build),
`bash scripts/security-audit.sh`; every new test executed by path; `bash -n` on
every canary script; capture self-test. Then the evidence document, focused
commits, and the stability gate (clean → 15s → clean, same HEAD).
No live provider inference.
