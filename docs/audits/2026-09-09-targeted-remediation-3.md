# CMM Subscription Router — Targeted Remediation 3 Evidence (2026-09-09)

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`

Follow-up to `docs/audits/2026-09-09-independent-reaudit-9ba8ffb.md`
(`AUDITED_HEAD=9ba8ffb`, verdict FAIL). This report is remediation
evidence, not an independent audit. A fresh human re-audit is still
required. No live provider quota was burned in this pass: all proof is
unit/contract, subprocess/socket-level, shell-matrix, build, and
compiled-process E2E with an in-process scripted double.

## Heads

- Start: `f752aea` (re-audit report commit)
- Final: recorded at bundle time (see `git log`)
- Tree: clean at report time (`git status --short` empty)

## Delta commits

- `a94130d` fix: stream Claude partial messages incrementally
  (also carries R5/R6: runtime profileDir injection + isolated health)
- `869ee2e` fix: remove Antigravity adapter streaming buffer
  (also carries A2: discovery temp cleanup)
- `02ce3f4` fix: make preflight provider-aware and fully fail closed
- `97b223a` fix: bootstrap shared config from production startup
- `2229368` fix: enforce Command Code deadline through response streaming
- `e4bc830` fix: isolate Command Code stream decoding per response
- `3a950f9` fix: surface Command Code timeout errors through both wires
- `aa48f8b` test: exercise actual compiled router process over HTTP
- `af74c60` test: prove socket disconnect cancels provider work
- `9de893f` fix: make Qoder smoke prove real cancellation
- `5022604` test: prove externally-owned tool loop contract with mocks
- `1220877` test: prove launchd plist, installer failure, and uninstall executably

## Finding-by-finding evidence

### R1 — Claude true incremental streaming (was CRITICAL FUNCTIONAL)

Root cause: the adapter consumed only complete `assistant` messages; the
SDK's incremental `stream_event` frames were never requested (`includePartialMessages`
unset) and never handled.

Changed: `src/providers/claude/adapter.ts` sets `includePartialMessages: true`,
extracts `content_block_delta`/`text_delta` via `extractStreamEventText()`,
yields `text_delta` on arrival, and suppresses the trailing duplicate
assistant echo once partials were seen. Completion stays terminal/exactly-once
from `result/success`; cancellation preserved.

Tests: `tests/providers/claude-partial-streaming.test.ts` (4 tests: SDK flag
assertion, first-delta-while-gated timing with `CLAUDE_FIRST_ROUTER_DELTA_BEFORE_UPSTREAM_COMPLETION=YES`,
no-duplicate A/B, cancellation). Gate is controlled BY THE TEST — the fake
yields A then blocks until release.

Verification: new suite green; all 6 Claude unit suites green (33 tests).

Limitation: live Claude streaming reproof still pending (no quota burned).

### R2 — Antigravity adapter buffering (was CRITICAL FUNCTIONAL)

Root cause: subprocess stdout was parsed incrementally but the adapter pushed
into `pendingTexts` and yielded only after `await streamInference()` resolved
at process close.

Changed: `src/providers/antigravity/adapter.ts` routes parsed events through
`StreamEventQueue`, drained concurrently while the child runs. Deltas yield
before exit; terminal bookkeeping unchanged (terminal result only, no
synthesis from close). The old self-releasing false-positive timing test was
replaced with a pointer to the race-proof suite.

Tests: `tests/providers/antigravity-true-streaming.test.ts`
(`ANTIGRAVITY_FIRST_ROUTER_DELTA_BEFORE_UPSTREAM_COMPLETION=YES`, second event
proven blocked until test release). All 5 Antigravity suites green (51 tests).

Limitation: live agy streaming reproof pending.

### A2 — Antigravity discovery temp leak

Root cause: `run()` cleaned its temp dir in `finally`; `discoverModels()`
never did.

Changed: discovery temp dir removed best-effort in `finally` on all paths.

Tests: `tests/providers/antigravity-discovery-cleanup.test.ts` (success +
throw, `ANTIGRAVITY_DISCOVERY_TEMP_CLEANUP=PASS`).

### R5 — Claude profileDir import-time capture (was MAJOR CONFIG)

Root cause: `CLAUDE_CONFIG_DIR` was computed at module load from
`process.env.CMM_CLAUDE_PROFILE_DIR`, but composition set that env var after
import — configured values were no-ops, plus a gratuitous global mutation.

Changed: `src/providers/claude/sdk-client.ts` resolves the default per call
(`defaultClaudeConfigDir()`); `buildIsolatedEnvironment(profileDir?)` takes
an explicit override. `ClaudeAdapter` accepts `{ profileDir }`;
`src/index.ts` passes it with no `process.env` write. `CLAUDE_CONFIG_DIR`
remains only for message/detail strings.

Tests: `tests/providers/claude-profiledir-health.test.ts`
(`CLAUDE_PROFILE_DIR_RUNTIME_WIRING=PASS`: import-first, construct with temp
profile, assert actual SDK env carries it).

### R6 — Claude health normal-profile oracle (was MAJOR ISOLATION)

Root cause: `health()` called `resolveSettings({ cwd })` with all sources,
then returned `ready` on any non-`firstParty` apiProvider without an
isolated check — the normal Claude/OmniRoute profile could decide health.

Changed: `resolveSettings` and `startup` both run with `settingSources: []`
(SDK isolation mode); the verdict comes from isolated `startup()` only.
Discovery and inference also carry `settingSources: []`.

Tests: same file (`CLAUDE_HEALTH_PROFILE_ISOLATION=PASS`: poisoned
third-party apiProvider ignored, `ready` follows isolated startup;
auth failure maps to `auth_required`).

Limitation: normal profile untouched by construction (no writes anywhere in
the adapter); live health reproof pending.

### R3 — Preflight fail-closed (was CRITICAL SECURITY/OPS)

Root cause: no `OPENAI_API_KEY` check; binary/auth absence never blocked;
`CODEX_CHATGPT_AUTH=AUTH_REQUIRED` still exited PASS.

Changed: `scripts/preflight.sh` reads provider enablement from shared config
(defaults on/on/on/off), reports `READY | AUTH_REQUIRED | UNAVAILABLE |
UNSAFE | SKIPPED_DISABLED`, and exits non-zero on any `UNSAFE`, any
`AUTH_REQUIRED`/`UNAVAILABLE` for an ENABLED provider, or missing node.
Disabled providers never block. Command Code secret absence blocks only when
explicitly enabled.

Tests: `tests/integration/preflight-matrix.test.ts` (7 cases: OpenAI-only
poison, Anthropic-only, Gemini-only, enabled AUTH_REQUIRED via command-code,
disabled+absent allowed, enabled+absent-binary blocked, node absent blocked).
Old fail-closed/redaction suites still green.

Verification: `OPENAI_RC=1`, `ANTHROPIC_RC=1`, `GEMINI_RC=1`; clean default
here reports `PREFLIGHT=FAIL rc=1` truthfully because Codex auth is
`AUTH_REQUIRED` in this environment.

### R4 — Fresh-clone bootstrap in production (was MAJOR DEPLOYMENT)

Root cause: `ensureSharedConfig()` existed but only tests called it; clean
clones failed schema parse on `{}`.

Changed: new `ensureSharedConfigFromExample()` installs
`config/shared.example.json` as `shared.json` (never overwrite, never
secrets, clear error when the example is missing). `createProductionRegistry()`
and `scripts/macos/install-router.sh` both invoke it. `CMM_CONFIG_DIR`
isolates the compiled-process E2E onto temp config.

Tests: `tests/config/fresh-clone-bootstrap.test.ts`
(`FRESH_CLONE_SHARED_CONFIG_BOOTSTRAP=PASS`,
`EXISTING_CONFIG_NOT_OVERWRITTEN=PASS`, missing-example error).

### R7 — Command Code full-stream deadline (was MAJOR RELIABILITY)

Root cause: the composed timeout was cleaned up when `fetch()` resolved at
headers; a body stalling mid-SSE could outlive `timeoutMs` forever. Adapter
catch blocks additionally swallowed timeouts as silent cancellation.

Changed (`src/providers/command-code/client.ts`, `adapter.ts`): timeout split
into headers + body phases. A remaining-budget watchdog aborts the composed
signal; the abort-aware `live()` generator tears down the hung body
(`throw`/`return` with handled rejections) and races each frame against the
abort edge so teardown settles promptly; `iterateWithDeadline` surfaces
`provider_timeout`; adapter yields timeout errors unless the caller genuinely
cancelled. No endpoint/model retry, no fallback, no spend-path change.

Tests: `tests/providers/command-code-body-timeout.test.ts` (stalled-after-
headers → `provider_timeout` with no completion; early abort → silent cancel;
under-deadline stream passes). Proven RED on the clean tree (2 failed before
the fix) and GREEN after. Existing header-stall suite still green.

### A3 — Shared streaming TextDecoder (was concurrency risk)

Root cause: one module-global stateful `TextDecoder` shared across concurrent
responses with `{ stream: true }`.

Changed: `newStreamDecoder()` per `streamChunks()` invocation.

Tests: `tests/providers/command-code-utf8-concurrency.test.ts` (source pin:
factory present, global gone — proven RED pre-fix; concurrent byte-split
emoji streams both decode cleanly).

### R8 — Real production-entrypoint E2E (was MAJOR VERIFICATION GAP)

Changed: `CMM_TEST_PROVIDER=scripted` opt-in seam in `createProductionRegistry`
(explicit env only; production defaults unchanged) + `src/testing/scripted-adapter.ts`
(no network/quota/secrets). `tests/http/dist-process-boot.test.ts` spawns
`node dist/index.js` with an isolated config dir and asserts over real TCP:
boot, `/health`, auth 401/200, non-empty `/v1/models`
(`ACTUAL_DIST_MODELS_NONEMPTY=PASS`), diagnostics, chat, responses, usage
recording (`ACTUAL_DIST_USAGE=PASS`), clean SIGTERM shutdown. The weak
models-200-only composition assertion was strengthened to non-empty.

### R9 — Real HTTP disconnect (was MAJOR VERIFICATION GAP)

Root cause: old test aborted an `AbortController` manually and called
`adapter.cancel()` directly — no HTTP involved; handlers only listened on
`request.raw` close.

Changed: chat + responses handlers now also tear down on `reply.raw` close
(mid-stream destroy). `tests/http/socket-disconnect.test.ts` uses a live
server + real TCP client: streams one chunk, destroys the socket mid-stream,
and asserts WITHOUT any test-side `cancel()` call that the provider saw
abort (`HTTP_SOCKET_DISCONNECT_PROPAGATION=PASS`,
`PROVIDER_ABORT_FROM_SOCKET_CLOSE=PASS`), `cancel()` fired, UsageStore
drained to zero actives with no success recorded (`ACTIVE_REQUEST_CLEANUP=PASS`).
All 11 HTTP suites green (54 tests).

### A1 — Smoke cancellation honesty

Root cause: smoke treated a fast HTTP 200 (`CANCEL_REACHABILITY=PASS`) as
cancellation proof.

Changed: `scripts/qoder-smoke.sh` opens a background stream, awaits the first
SSE frame (bounded, tempfile polling — no FIFOs), SIGKILLs the client, and
polls `/v1/cmm/usage` for `cancelledEvents` increment + zero actives
(`QODER_SMOKE_CANCELLATION=PASS`). Too-fast completions report
`BLOCKED_EXTERNAL_PRECONDITION`, never PASS. New `cancelledEvents` counter in
`UsageStore.aggregates()` + `/v1/cmm/usage` (counts only, no content).

Tests: `tests/integration/qoder-smoke-cancel.test.ts` (semantics pins + live
scripted-server run; instant double honestly yields BLOCKED rather than a
fake PASS). Old smoke contract still green.

Limitation: real mid-stream cancellation against a slow live provider is
unproven (no quota burned); the mechanism is proven by the socket test +
router books.

### Task 13 — Original DoD (unchanged scope verdict)

Investigated seriously without fabricating support. The router relays tool
CALLS (deltas + OpenAI `tool_calls` shape on chat/responses) and accepts tool
RESULTS (`role: tool` messages) — proven by the new mocked two-turn relay
test `tests/http/tool-loop-contract.test.ts` (`TOOL_LOOP_CONTRACT=PASS`:
request → tool call → Qoder-executed result supplied back → final answer,
router executes nothing). But NO live provider has emitted a real tool call
under forcing prompts (live suites report `CHAT_ONLY_NO_TOOL_EMITTED`, skipped
here without `CMM_RUN_LIVE=1`); Claude runs with native tools disallowed by
design. Capabilities therefore stay `CHAT_ONLY` on all four routes.

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
```

The scope decision (amend v1 to chat-only vs. implement live round-trips per
route) belongs to the human. Nothing was auto-amended.

### Launchd executable smoke (delta item 14)

Manually verified: real `install-router.sh` run rendered a `plutil -lint OK`
plist with resolved program arguments, then `uninstall-router.sh` removed it
(temp state cleaned; `config/shared.json` bootstrap artifact removed since it
is gitignored). Tests: `plutil` lint (`PLIST_VALID=PASS`,
`PROGRAM_ARGUMENTS_EXIST=PASS`), real-installer missing-template failure
(`INSTALL_FAILURE_PROPAGATION=PASS`), uninstaller removal (`UNINSTALL=PASS`).
`launchctl bootstrap` was NOT attempted (would disturb user services):
`LAUNCHD_RUNTIME_SMOKE=BLOCKED_TEST_ENVIRONMENT`.

## Verification (no live quota burned)

```text
TEST_RUN_1: 50 files passed | 5 skipped; 324 passed | 25 skipped
TEST_RUN_2: 50 files passed | 5 skipped; 324 passed | 25 skipped
TEST_RUN_3: 50 files passed | 5 skipped; 324 passed | 25 skipped
POST_BUILD_TEST: 324 passed | 25 skipped
TYPECHECK: PASS (tsc --noEmit clean)
BUILD: PASS
SECURITY_AUDIT: PASS (extended script, all sections)
PREFLIGHT default: FAIL rc=1 (truthful: Codex AUTH_REQUIRED here)
POISON PROBES: OPENAI_RC=1, ANTHROPIC_RC=1, GEMINI_RC=1
LIVE_TESTS_RUN: NO
```

## Security re-scan

- Tracked `user_…` secret scan: clean.
- `0.0.0.0` bind scan: clean (only the audit script's own detection string).
- Provider `console.*` content logging: none in `src/providers`, `src/http`.
- PAYG guard lists `OPENAI/ANTHROPIC/GEMINI/GOOGLE` keys; startup + adapters
  strip/verify; Command Code spend paths still refused, no on-demand/top-up.
- No OAuth extraction/copy/sync paths added; no cross-provider or
  unknown-model fallback added.
- Command Code key from chat never written to disk/env/git; spend ack never
  created here; normal Claude profile / OmniRoute / Antigravity settings
  untouched; Qwen untouched.

## Standing constraints (unchanged)

```text
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
PROMPT_LOGGING=NONE
COMPLETION_LOGGING=NONE
TOOL_BODY_LOGGING=NONE
ROUTER_BIND=127.0.0.1
```

## Known limitations / next

- Live reproof pending for Claude/Antigravity/Command Code streaming,
  health, and GOAT inference (requires human credentialed runs; hooks block
  agent-side secrets).
- Task 13 original DoD NOT_MET; human scope decision required.
- Qoder UI acceptance + iMac live install remain externally blocked.
- `launchctl bootstrap` runtime smoke blocked by test environment.
