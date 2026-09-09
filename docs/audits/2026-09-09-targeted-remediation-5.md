# CMM Subscription Router — Targeted Remediation 5 Evidence (2026-09-09)

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`

Follow-up to `docs/audits/2026-09-09-independent-reaudit4-d2a1d6f.md`
(`AUDITED_HEAD=d2a1d6f`, verdict FAIL). This report is remediation
evidence, not an independent audit. A fresh human re-audit is still
required. No live provider quota was burned: Codex tests use fake local
transports and scripted protocol servers; Command Code abort proof uses a
real local HTTP server with no upstream; all other proof is unit/contract,
shell-matrix, build, and compiled-process checks.

## Heads

- Start: `1975c05` (re-audit 4 report commit)
- Final: recorded at bundle time (see `git log`)
- Tree: clean at report time (`git status --short` empty)

## Delta commits

- `ff2e283` fix: align Codex client with generated app-server protocol
- `f49766c` fix: scope Codex runs by thread and turn with role preservation
- `93d7c40` fix: propagate Command Code abort through native body lifecycle
- `313684f` fix: fail preflight on malformed shared config
- `ff8dfac` fix: reject tool-call history for chat-only models
- `186edd0` fix: make launchd runtime paths and secret names deterministic
- `9ae0f3d` fix: ignore bootstrapped local shared config
- (this report) docs: add targeted remediation 5 evidence

## Finding-by-finding evidence

### 1 — Codex protocol conforms to the generated schema

Root cause: hand-written `protocol.ts` assumed `turn/start → { turnId }`
and flat token fields, contradicting the tracked v2 artifacts
(`TurnStartResponse` requires `turn` with `Turn.id`; token usage nests
under `tokenUsage.{last,total}`; deltas carry `delta/itemId/threadId/turnId`;
completion carries `{ threadId, turn }`; interrupt requires both ids).

Changed: new `src/providers/codex/schema-protocol.ts` (schema-backed
payload types citing exact artifact names) + `schema-translator.ts`
(validating parsers/builders that fail closed with
`provider_protocol_error`). Stale hand-written payload shapes in
`protocol.ts` marked `@deprecated` with pointers to the schema layer;
envelope plumbing (JSON-RPC request/response/notification) stays there.

Tests (`tests/providers/codex-schema-conformance.test.ts`, 9 tests):
fixtures from the TRACKED artifacts drive required-key drift assertions
plus translator behavior — `CODEX_TURN_START_ID_FROM_SCHEMA=PASS`,
`CODEX_TOKEN_USAGE_FROM_SCHEMA=PASS`, `CODEX_COMPLETION_FROM_SCHEMA=PASS`,
`CODEX_CANCEL_USES_REAL_TURN_ID=PASS` (builder refuses empty ids),
`CODEX_PROTOCOL_DRIFT_GUARD=PASS`. Legacy flat shapes proven rejected.
Old client fixtures updated to schema nesting.

Source of truth artifacts used:
`tests/fixtures/generated/codex/v2/{TurnStartResponse,
ThreadTokenUsageUpdatedNotification, AgentMessageDeltaNotification,
TurnCompletedNotification, TurnInterruptParams, ThreadStartParams,
TurnStartParams, ThreadInjectItemsParams}.json`.

Commit: `ff2e283`. Remaining limitation: live app-server cross-check
pending (no quota burned).

### 2 — Codex notifications isolated by thread and turn

Root cause: global waiter list matched on method only; timeout removed all
overlapping waiters instead of just the expired one.

Changed (`src/providers/codex/app-server-client.ts`): waiters carry
optional `{ threadId, turnId }` scope plus unique `id`. Dispatch requires
method AND correlation match (turn completion accepts both flat `turnId`
and nested `turn.id`). Queue checks are scope-aware; unscoped callers keep
legacy method-only behavior. Timeouts remove only the expired waiter by id.
New `NotificationScope` param on both waiter methods (optional, backward
compatible). Stale/foreign notifications queue harmlessly and never reach
another run.

Tests (`tests/providers/codex-notification-isolation.test.ts`): two
simultaneous fake conversations with deliberate interleave
(B1,A1,B-usage,A2,A-done,B2,B-done) on the REAL production dispatcher —
`CODEX_REQUEST_A_TEXT=A1A2`, `CODEX_REQUEST_B_TEXT=B1B2`,
`CODEX_CROSS_THREAD_{DELTA,USAGE,COMPLETION}_LEAK=NONE`, plus scoped
timeout isolation (`CODEX_CONCURRENT_NOTIFICATION_ISOLATION=PASS`). Proven
2-failed pre-fix on the stashed tree.

Commit: `ff2e283`.

### 3 — Codex conversation roles preserved

Root cause: every Router message became an undifferentiated `{ type: text }`
input item; system/history roles were lost.

Changed (`src/providers/codex/adapter.ts` `buildCodexThreadSeeds()`): system
→ `thread/start` `developerInstructions` (schema field); prior user/assistant
turns → Responses-API history items via `thread/injectItems` (roles
preserved, `input_text`/`output_text` content); only the newest user text
starts the turn; tool roles become labelled user text (external loop owns
execution). Threads start with explicit `ephemeral: true` (schema field).
Turn id parsed from `result.turn.id`; usage from nested `tokenUsage`;
completions from `{ threadId, turn }` with `failed` mapped to a protocol
error; cancel validates ids before `turn/interrupt` (never empty).
`injectItems()` added to the client. No native workspace tools enabled.

Tests (`tests/providers/codex-conversation-lifecycle.test.ts`): seed-level
markers/order (`CODEX_SYSTEM_PRESERVED=YES`, `CODEX_USER_HISTORY_PRESERVED=YES`,
`CODEX_ASSISTANT_HISTORY_PRESERVED=YES`, `CODEX_MESSAGE_ORDER_PRESERVED=YES`,
`CODEX_ROLE_FLATTENING=NONE`) AND actual JSON-RPC inspection over a scripted
server (`CODEX_THREAD_EPHEMERAL_EXPLICIT=YES`, `..._VALUE=true`, inject
contents, turn input scoping, completion, real-id cancel).

Commits: `f49766c` (+ `ff2e283` client half). Remaining limitation: live
Codex conversation reproof pending.

### 4 — Codex threads explicitly ephemeral

Covered in item 3: `buildThreadStartParams({ ..., ephemeral: true })` on
every production thread start, asserted against actual outgoing
`thread/start`. No Router-side prompt/history persistence added.

### 5 — Codex protocol drift guard

Covered in item 1: the conformance suite's final test asserts tracked
required keys for turn/start, token usage, delta, completion, and interrupt
against the translator assumptions — incompatible schema evolution fails
loudly. `CODEX_PROTOCOL_DRIFT_GUARD=PASS`.

### 6 — Command Code native body teardown

Root cause: the default fetch wrapper double-composed a timeout signal and
cleaned it at headers, detaching the native body reader; the outer watchdog
made the Router return while the socket stayed alive.

Changed (`src/providers/command-code/client.ts`): the wrapper passes the
caller-composed OPERATION signal straight to native `fetch` for the entire
body lifecycle (no second composition, no headers-time cleanup), wires
reader/body `cancel()` to abort, and removes the listener on settle.
User-facing mapping unchanged (deadline → `provider_timeout`, caller abort
silent). All 7 Command Code suites green (48 tests).

Tests (`tests/providers/command-code-native-abort.test.ts`, real local HTTP
server, headers + one chunk then stall): deadline → `provider_timeout` AND
server-observed socket close (`COMMAND_CODE_ROUTER_TIMEOUT=PASS`,
`COMMAND_CODE_NATIVE_BODY_ABORTED=YES`, `..._PROOF=PASS`,
`..._CLEANUP=PASS`); client abort → silent + socket close. Proven 2-failed
pre-fix.

Commit: `93d7c40`. Remaining limitation: real-upstream socket reproof
pending (local server is faithful for signal lifetime, not for vendor TLS).

### 7 — Preflight malformed config fails closed

Root cause: `PARSE_FAIL` was ignored; defaults stayed active → `PREFLIGHT=PASS`.

Changed (`scripts/preflight.sh`): present `shared.json` is validated (JSON
well-formedness, top-level keys, loopback host) before enablement parsing;
invalid files emit `CONFIG=INVALID` and exit non-zero ahead of all other
verdicts. Missing files keep the bootstrap path.

Tests (`tests/integration/preflight-malformed.test.ts`):
`PREFLIGHT_MALFORMED_JSON=FAIL_CLOSED`,
`PREFLIGHT_SCHEMA_INVALID_CONFIG=FAIL_CLOSED`, valid-config continuation.
All 16 preflight tests green.

Commit: `313684f`.

### 8 — CHAT_ONLY rejects assistant tool-call history

Root cause: `parseMessages()` drops `tool_calls`; the guard only saw
top-level tools/selection and `role === "tool"`.

Changed (`src/http/openai-chat.ts`): `rawBodyHasAssistantToolHistory()`
scans the RAW body (chat `tool_calls`/`function_call`, Responses
`function_call`/`function_call_output`/`tool_call`/`tool_result` at item or
content-part level). Responses handler runs the guard on the raw body BEFORE
`inputToMessages` can discard the shape, then again parsed. Same
`unsupported_capability` 400, zero invocations, no fallback.

Tests: two new cases in `tests/http/chat-only-enforcement.test.ts`
(`CHAT_ONLY_ASSISTANT_TOOL_HISTORY_REJECTED=PASS` on chat; responses
function_call rejected). All 12 HTTP suites green (66 tests).

Commit: `ff8dfac`.

### 9 — Launchd deterministic executables and secret names

Root cause: wrapper `exec node` relied on LaunchAgent PATH; Codex spawned
bare `codex`; wrapper hard-coded `CMM_ROUTER_TOKEN`/`COMMAND_CODE_SECRET`
while config allows custom names.

Changed: installer resolves absolute node/codex paths, prefers effective
configured `agyPath`, builds a deduplicated `SAFE_PATH`, and bakes
`__NODE_BIN__`/`__CODEX_BIN__`/`__AGY_BIN__`/`__SAFE_PATH__` into the plist
template (new keys). `run-router.sh` executes `$NODE_BIN`, reads secret env
NAMES from shared config via indirect expansion, and exports Keychain values
under those exact names (never values in tracked files). `CodexAdapter`
prefers constructor → `CMM_ROUTER_CODEX_BIN` → PATH. `launchctl bootstrap`
NOT attempted (would disturb user services):
`LAUNCHD_RUNTIME_SMOKE=BLOCKED_TEST_ENVIRONMENT`.

Tests (`tests/integration/launchd-deterministic.test.ts`):
`LAUNCHD_NODE_PATH_ABSOLUTE=PASS`, `LAUNCHD_CODEX_PATH_RESOLVED=PASS`,
`LAUNCHD_AGY_PATH_CONFIG_RESPECTED=PASS` (present + missing directions),
`LAUNCHD_ROUTER_TOKEN_ENV_NAME_CONFIG=PASS`,
`LAUNCHD_COMMAND_SECRET_ENV_NAME_CONFIG=PASS`,
`LAUNCHD_NO_SECRET_VALUE_IN_TRACKED_ARTIFACT=PASS`. All 16 launchd tests
green (13 prior + 3 new).

Commits: `186edd0` (+ `9ae0f3d` gitignore hygiene: bootstrapped
`config/shared.json` now ignored so first runs never dirty the tree).

### 10 — Task 13 (unchanged, per instructions)

No provider-specific live tool loop implemented or claimed. Mocked neutral
relay contract stands as plumbing evidence only. Enforcement (items 8 +
prior pass) is truthfulness, not fulfillment:

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=chatgpt/CHAT_ONLY claude/CHAT_ONLY google/CHAT_ONLY command-code/CHAT_ONLY
```

No scope auto-amendment; human decides after live chat acceptance.

## Verification (no live quota burned)

```text
TEST_RUN_1: 372 passed | 25 skipped
TEST_RUN_2: 372 passed | 25 skipped
TEST_RUN_3: 372 passed | 25 skipped
POST_BUILD_TEST: 372 passed | 25 skipped
TYPECHECK: PASS
BUILD: PASS
SECURITY_AUDIT: PASS
POISON PROBES: OPENAI_RC=1, ANTHROPIC_RC=1, GEMINI_RC=1
TARGETED REGRESSIONS (30 tests, 7 files): PASS
LIVE_TESTS_RUN: NO
```

## Security re-scan

- Tracked `user_…` values: none.
- `0.0.0.0` in sources: none.
- Provider/HTTP `console.*` content logging: none.
- `oauth`/`api_key`/`access_token` hits: guards only (wire rejection list,
  PAYG allowlists, settings-gate messages) — no extraction/copy/sync.
- Codex concurrency: cross-thread leak markers all NONE in the isolation
  suite (`CODEX_CROSS_REQUEST_CONTENT_LEAK=NONE` by construction — scoped
  dispatch plus per-request adapters).
- Invariants hold: `API_PAYG_FALLBACK=NONE`, `CROSS_PROVIDER_FALLBACK=NONE`,
  `UNKNOWN_MODEL_FALLBACK=NONE`, `COMMAND_CODE_ON_DEMAND=NONE`,
  prompt/completion/tool-body logging NONE, bind `127.0.0.1`.
- Normal Claude/OmniRoute config untouched; Antigravity global settings
  untouched; Qwen untouched; Command Code key/ack never created here.

## Known limitations / next

- Live Codex conversation/cancel/usage reproof, live GOAT inference, Qoder
  UI acceptance, iMac install: externally gated, pending human runs.
- Task 13 DoD NOT_MET by design; scope decision is the human's.
- `launchctl bootstrap` runtime smoke blocked by test environment.
- Default preflight here reports PREFLIGHT=FAIL rc=1 truthfully only when an
  enabled provider needs auth (e.g. Codex AUTH_REQUIRED); poison probes all
  rc=1 independently.
