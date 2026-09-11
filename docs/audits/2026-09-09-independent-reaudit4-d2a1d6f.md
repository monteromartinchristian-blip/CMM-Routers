# CMM Subscription Router — Independent Re-audit 4

**Date:** 2026-09-09
**Audited commit:** `d2a1d6f61d45cda993871f524dc3d7d7153fe6a2`
**Prior independent re-audit:** `docs/audits/2026-09-09-independent-reaudit3-c2b23dd.md`
**Remediation evidence under review:** `docs/audits/2026-09-09-targeted-remediation-4.md`

## Executive verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT_4=FAIL
AUDITED_HEAD=d2a1d6f61d45cda993871f524dc3d7d7153fe6a2
REMEDIATION_4_FINDINGS=SUBSTANTIALLY_FIXED
FINAL_CLOSURE_ELIGIBLE=NO
LIVE_FINAL_REPROOF_AUTHORIZED=NO
TASK_13_ORIGINAL_DOD=NOT_MET
NEXT=TARGETED_REMEDIATION_5_CODEX_AND_RUNTIME_INTEGRITY
```

Targeted Remediation 4 successfully fixed the seven substantive defects identified in re-audit 3 plus the environment-example cleanup. The test signal is strong and reproducible. However, independent review of the exact archive exposed several pre-existing integration defects outside that narrow delta, concentrated in the Codex adapter/client and macOS runtime path. Two Codex issues are critical because they can break cancellation/usage or cross conversation data between concurrent requests.

No live provider quota should be burned until the critical Codex findings below are remediated and independently re-audited.

---

## 1. Artifact integrity

Independent verification:

```text
ARCHIVE_GZIP=PASS
ARCHIVE_COMMIT=d2a1d6f61d45cda993871f524dc3d7d7153fe6a2
BUNDLE_SHA256=c542a6771e4b02e20659ba3decba4f5f02c23e74186c13ed9c77125f71f4b150
LOG_SHA256=34eff556dad271b482a72353de9e705ad9d1ad64b15c73d91a08fd6fb84fdb36
WORKTREE_AT_CAPTURE=CLEAN
```

The tarball is an exact `git archive` of the stated HEAD.

---

## 2. Verification signal

The supplied verification capture reports, on the exact audited HEAD:

```text
TEST_RUN_1=348 passed / 25 skipped
TEST_RUN_2=348 passed / 25 skipped
TEST_RUN_3=348 passed / 25 skipped
POST_BUILD_TEST=348 passed / 25 skipped
TYPECHECK=PASS
BUILD=PASS
SECURITY_AUDIT=PASS
OPENAI_PAYG_POISON_RC=1
ANTHROPIC_PAYG_POISON_RC=1
GOOGLE_PAYG_POISON_RC=1
ACTUAL_DIST_PROCESS=PASS
SOCKET_DISCONNECT=PASS
```

This is a strong deterministic regression signal. It does **not** cover the live-gated provider suites, which remain intentionally skipped.

---

# 3. Re-audit 3 findings — remediation status

## R4-1 — Claude conversation context

**Status: PASS**

`src/providers/claude/adapter.ts` now:

- maps system messages to the SDK `systemPrompt` field;
- preserves ordered user and assistant history;
- passes the actual ordered prompt iterable to `query()`;
- retains `includePartialMessages: true`;
- keeps native provider tools disabled.

`tests/providers/claude-conversation.test.ts` inspects the runtime SDK invocation path rather than only a disconnected helper.

Independent source review found no recurrence of the previous user-only filtering defect.

## R4-2 — Antigravity conversation context

**Status: PASS**

`src/providers/antigravity/adapter.ts` now serializes system/user/assistant history into the actual `agy --print` prompt in deterministic role-labelled order. The prompt is not logged and unsafe tool permissions remain blocked.

`tests/providers/antigravity-conversation.test.ts` validates the actual spawned argument.

## R4-3 — CHAT_ONLY boundary enforcement

**Status: PASS for the primary requested paths; residual edge case recorded separately below.**

`rejectChatOnlyTools()` now rejects, before provider execution:

- non-empty `tools`;
- `tool_choice`;
- `parallel_tool_calls`;
- tool-role continuation messages.

Both `/v1/chat/completions` and `/v1/responses` use the guard. Tests prove provider invocation count remains zero and no fallback occurs.

The original Task 13 remains correctly reported as `NOT_MET`; this enforcement improves truthfulness but does not implement a real provider tool round-trip.

## R4-4 — Command Code discovery/error body deadlines

**Status: PASS for caller-visible deadline behavior.**

`GET /models` and non-2xx error body reads are now bounded by the remaining request budget. The new tests exercise headers-first/body-stall cases and preserve normal specific error mapping when the body completes.

A lower-level native-fetch cancellation/resource-lifetime defect remains and is recorded as a new finding below.

## R4-5 — Antigravity all-path temp cleanup

**Status: PASS**

Per-request temp creation now occurs after early validation gates and all paths after creation are protected by cleanup. New tests cover protocol error, spawn failure and poisoned/invalid early paths.

## R4-6 — Preflight effective provider configuration

**Status: PASS for valid configuration.**

Preflight now respects:

- `claude.profileDir`;
- `google.agyPath`;
- `command-code.secretEnv`.

The configured `agyPath` is authoritative and the configured Command Code env name is dereferenced correctly. A malformed-config fail-open issue remains separately below.

## R4-7 — Claude authentication guidance

**Status: PASS**

Auth guidance is generated from the adapter's effective configured profile rather than a stale module-level default.

## R4-8 — Environment example alignment

**Status: PASS**

The misleading `CMM_ROUTER_HOST` / `CMM_ROUTER_PORT` entries were removed. Loopback remains schema-locked to `127.0.0.1`.

---

# 4. New independent findings

## B1 — CRITICAL — Hand-written Codex protocol disagrees with the generated protocol shipped in the same HEAD

### Evidence

`src/providers/codex/protocol.ts` defines:

```ts
export interface TurnStartResponse {
  turnId: string;
}
```

and the adapter uses:

```ts
const turnResponse = await this.client.startTurn(...);
this.activeTurns.set(request.requestId, {
  threadId,
  turnId: turnResponse.turnId,
});
```

But the exact generated schema stored at:

`tests/fixtures/generated/codex/v2/TurnStartResponse.json`

defines:

```text
required = ["turn"]
properties = { turn: Turn }
Turn.required includes "id"
```

Therefore the schema-backed turn ID is `response.turn.id`, not `response.turnId`.

The mismatch is also present in token usage. `protocol.ts` expects token counts directly under notification params, while:

`tests/fixtures/generated/codex/v2/ThreadTokenUsageUpdatedNotification.json`

requires:

```text
threadId
turnId
tokenUsage
```

with the token counts nested under `tokenUsage`.

The unit tests currently reinforce the stale hand-written contract by faking:

```json
{"result":{"turnId":"turn-456"}}
```

rather than using the generated schema shape.

### Impact

- active Codex turns can be recorded with `turnId = undefined`;
- `turn/interrupt` can receive an empty/invalid turn ID;
- real cancellation proof is unreliable;
- Codex usage events can be emitted without the actual token values;
- the code violates the implementation plan requirement to use the current generated app-server schema rather than stale assumptions.

### Required remediation

Generate/use schema-backed types or update the hand-written types to the exact archived v2 schema. At minimum:

- parse `turn/start` from `result.turn.id`;
- parse token usage from `params.tokenUsage`;
- update fake fixtures/tests to match generated schema;
- add schema-conformance tests that consume representative JSON generated from the stored schema rather than a parallel invented shape.

Required evidence:

```text
CODEX_TURN_START_SCHEMA_CONFORMANCE=PASS
CODEX_INTERRUPT_TURN_ID_FROM_SCHEMA=PASS
CODEX_TOKEN_USAGE_SCHEMA_CONFORMANCE=PASS
```

---

## B2 — CRITICAL — Codex notification dispatch is not scoped by thread/turn and can cross-talk between concurrent Qoder requests

### Evidence

`CodexAppServerClient` has one global notification queue and a global waiter list. In `handleMessage()`, a notification waiter is selected only by notification **method**:

```ts
if (w.method === notification.method) return true;
if (w.methods && w.methods.includes(notification.method)) return true;
```

`waitForAnyNotification()` likewise dequeues only by method.

The generated schemas explicitly provide correlation fields:

- `AgentMessageDeltaNotification`: `threadId`, `turnId`;
- `ThreadTokenUsageUpdatedNotification`: `threadId`, `turnId`;
- `TurnCompletedNotification`: `threadId`, plus `turn.id`.

`CodexAdapter.run()` knows its `threadId` and turn ID, but calls:

```ts
waitForAnyNotification([
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "turn/completed",
])
```

without a correlation predicate.

The adapter reuses one shared app-server client and permits multiple active turns in `activeTurns`, so this is a real concurrency boundary, not an unreachable code path.

A direct reproduction of the dispatch algorithm shows that with waiter A registered before waiter B, a delta carrying `threadId=thread-B` is consumed by waiter A because the method matches and no thread scope is checked.

There is a second concurrency bug in timeout cleanup: a timed-out `waitForAnyNotification()` removes every waiter whose method-set overlaps, rather than only the waiter whose timer fired.

### Impact

In concurrent Qoder calls:

- request A can receive text generated for request B;
- completion or usage from one turn can terminate/update another turn;
- this is both a correctness defect and a privacy boundary failure.

### Required remediation

Add notification correlation predicates / scoped subscriptions. Queue matching and waiter matching must require the expected `threadId` and, once known, `turnId`.

Each waiter needs a unique identity so its timeout removes only itself.

Required race test:

1. start two distinct simulated threads/turns;
2. register both consumers;
3. interleave B delta, A delta, B usage, A completion, B completion;
4. prove each consumer receives only its own events;
5. time out one scoped waiter and prove the other remains registered.

Required evidence:

```text
CODEX_CONCURRENT_NOTIFICATION_ISOLATION=PASS
CODEX_CROSS_REQUEST_TEXT_CONTAMINATION=NONE
CODEX_CROSS_REQUEST_USAGE_CONTAMINATION=NONE
CODEX_SCOPED_WAITER_TIMEOUT_ISOLATION=PASS
```

---

## B3 — MAJOR — Codex still loses role semantics for system and assistant history

### Evidence

Every Router request creates a fresh Codex thread. The adapter then maps **all** Router messages to the same Codex `UserInput` text shape:

```ts
request.messages.map(msg => ({
  type: "text",
  text: msg.content || "",
}))
```

System, user and previous assistant messages therefore become an undifferentiated list of input text items in one new user turn.

The generated protocol already exposes semantically appropriate facilities:

- `ThreadStartParams.developerInstructions` / `baseInstructions`;
- `thread/injectItems` with the description: "Raw Responses API items to append to the thread's model-visible history."

The implementation plan explicitly requires flattening system/user/assistant/tool history into Codex input/context, not discarding role identity.

### Impact

For Qoder multi-turn chat:

- system/harness instructions are not distinguished as instructions;
- previous assistant text can be interpreted as new user input;
- conversation behavior can diverge materially from the other providers and from the OpenAI-compatible request supplied by Qoder.

### Required remediation

Use the generated app-server protocol to preserve semantics. Recommended direction:

- map Router system instructions to `developerInstructions` (or the exact schema-supported instruction field);
- append prior user/assistant history using `thread/injectItems` or another schema-backed model-visible history mechanism;
- start the turn with the current user input only;
- do not enable native workspace tools.

Add actual JSON-RPC request tests with role markers and correct ordering.

Required evidence:

```text
CODEX_SYSTEM_PRESERVED=YES
CODEX_USER_HISTORY_PRESERVED=YES
CODEX_ASSISTANT_HISTORY_PRESERVED=YES
CODEX_MESSAGE_ORDER_PRESERVED=YES
```

---

## B4 — MAJOR — Codex threads are described as ephemeral but `ephemeral` is never set

### Evidence

The implementation plan requires ephemeral Codex threads. The generated `ThreadStartParams` schema includes an explicit nullable `ephemeral` boolean.

`CodexAdapter.run()` starts the thread with only:

```ts
{
  model: request.model.upstreamModel,
  sandbox: "read-only"
}
```

No `ephemeral: true` is passed.

### Impact

The current implementation does not prove the plan's privacy/lifecycle requirement that routed requests use ephemeral threads. The server default must not be assumed to satisfy an explicit design requirement when the generated protocol exposes the control directly.

### Required remediation

Use the exact schema-supported ephemeral setting and add a JSON-RPC assertion:

```text
CODEX_EPHEMERAL_THREAD=YES
```

---

## B5 — MAJOR — Command Code timeout returns to the caller but the native fetch body can remain alive after headers

### Evidence

The high-level Command Code operation creates a composed timeout signal and passes it as `init.signal` to `fetchFn`.

The default `fetchFn`, however, composes **another** timeout signal internally:

```ts
const composed = composeTimeoutSignal(init.signal, this.timeoutMs);
try {
  const response = await fetch(url, { signal: composed.signal, ... });
  return { ...stream wrapper... };
} finally {
  composed.cleanup();
}
```

That inner cleanup runs immediately when `fetch()` resolves at headers. It removes the listener that propagates later aborts from the outer operation signal to the actual native-fetch signal.

The outer stream watchdog can therefore make the Router return `provider_timeout`, but aborting the outer signal no longer necessarily cancels a native `reader.read()` already waiting on the response body.

Independent Node 22 local-server reproduction of this exact signal-lifetime pattern produced:

```text
FIRST_DONE=false
AFTER_OUTER_ABORT_READER_SETTLED=NO
AFTER_INNER_ABORT=rejected:AbortError
```

The current tests use custom `streamChunks`/fake responses and prove caller-visible timeout latency, but do not prove native socket/body teardown.

### Impact

Repeated stalled upstream responses or cancellations can leave native HTTP body work/socket resources alive after the Router has considered the request finished.

### Required remediation

Do not double-compose and clean the native-fetch signal at headers. Prefer passing the already-composed operation signal directly to native `fetch`, keeping that signal active for the entire body lifetime. Also actively cancel/release the response reader/body on timeout or iterator cancellation where applicable.

Add a real local HTTP-server test that sends headers + one chunk then stalls and asserts the server observes connection close after Router timeout/client abort.

Required evidence:

```text
COMMAND_CODE_NATIVE_BODY_ABORT_ON_TIMEOUT=PASS
COMMAND_CODE_NATIVE_BODY_ABORT_ON_CLIENT_CANCEL=PASS
```

---

## M1 — MAJOR deployment gap — LaunchAgent runtime has no proven executable PATH / absolute Node-Codex resolution

### Evidence

`launchd/com.cmm.subscription-router.plist.template` defines no explicit `PATH`.

`scripts/macos/run-router.sh` ends with:

```bash
exec node "$REPO_DIR/dist/index.js"
```

and the Codex adapter defaults to spawning bare:

```text
codex
```

The test suite validates plist syntax, paths and installer failure propagation, but the actual `launchctl bootstrap` runtime smoke is explicitly still blocked/unperformed.

### Impact

Task 17 is not independently proven. A LaunchAgent environment that cannot resolve the user's Node/Codex binaries will fail even though terminal execution works.

This does not block a manual terminal live-provider test, but it blocks macOS background-service closure.

### Required remediation

Resolve/store explicit executable paths at installation time or provide a deliberately constructed safe PATH that contains the actual Node/Codex locations. Do not rely on interactive shell initialization.

Then perform a real temporary-label `launchctl bootstrap` smoke on the MacBook before iMac deployment.

---

## M2 — MEDIUM — macOS wrapper ignores configurable bearer/Command Code secret environment names

### Evidence

Configuration supports:

```text
bearerSecretEnv
providers.command-code.secretEnv
```

Production reads those configured names. Preflight now also respects the configured Command Code secret env.

But `scripts/macos/run-router.sh` always exports:

```text
CMM_ROUTER_TOKEN
COMMAND_CODE_SECRET
```

### Impact

A valid non-default config can pass schema/preflight yet fail under LaunchAgent because the wrapper injects Keychain values into different variable names from those production expects.

### Required remediation

Either remove the env-name configurability and standardize the fixed names, or have the wrapper safely read the configured names and export Keychain material under those exact names without logging values.

---

## M3 — MEDIUM — malformed `shared.json` makes preflight silently fall back to defaults

### Evidence

In `scripts/preflight.sh`, JSON parsing returns `PARSE_FAIL`, but `PARSE_FAIL` is simply ignored and default enablement/options remain active.

Independent execution with deliberately invalid `shared.json`, fake-ready provider binaries and safe environment produced:

```text
PREFLIGHT=PASS
RC=0
```

Production `loadConfig()` would not accept that same malformed configuration.

### Impact

Preflight can claim readiness for configuration that production cannot load. This violates the intended fail-closed/truthful preflight contract.

### Required remediation

If `shared.json` exists and cannot be parsed/validated, emit an explicit configuration-invalid state and exit non-zero.

Required:

```text
PREFLIGHT_MALFORMED_CONFIG=FAIL_CLOSED
```

---

## M4 — MEDIUM/LOW — CHAT_ONLY guard misses assistant messages containing `tool_calls`

### Evidence

`parseMessages()` does not parse or record an assistant message's `tool_calls` member. `rejectChatOnlyTools()` checks top-level tools/tool-selection fields and `role === "tool"`, but not assistant `tool_calls` history.

Therefore an OpenAI chat request carrying historical assistant tool calls without a current top-level tools array can lose that semantic information rather than deterministically failing as an unsupported CHAT_ONLY conversation.

### Required remediation

Detect tool-call history in the raw request before discarding it, and reject it on CHAT_ONLY routes with the same stable `unsupported_capability` error.

Required:

```text
CHAT_ONLY_ASSISTANT_TOOL_CALL_HISTORY_REJECTION=PASS
```

---

## L1 — LOW — fresh-clone bootstrap creates an untracked `config/shared.json`

`config/shared.json` is not present in the archive and is not listed in `.gitignore`. The production bootstrap therefore creates a new working-tree file on first run.

This is primarily repository hygiene, not a runtime blocker. Decide explicitly whether shared config should be tracked/synchronized or locally ignored; avoid an accidental dirty worktree as an undocumented side effect of starting the Router.

---

# 5. Security/invariant regression scan

Independent source scan found no regression in the central economic/privacy invariants:

```text
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
COMMAND_CODE_AUTO_TOP_UP=NONE
LOOPBACK_BINDING=127.0.0.1
CONTENT_LOGGING=NONE in provider/http runtime
CLAUDE_GLOBAL_ENV_MUTATION=NONE
ANTIGRAVITY_UNSAFE_PERMISSION_FLAG=BLOCKED
```

PAYG variable references in production are guards/removal logic rather than spend fallbacks.

---

# 6. Task 13 / v1 scope

The implementation remains honest:

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=
  chatgpt/CHAT_ONLY
  claude/CHAT_ONLY
  google/CHAT_ONLY
  command-code/CHAT_ONLY
```

The provider-neutral mocked tool loop is useful plumbing evidence but is not provider acceptance.

The new CHAT_ONLY enforcement is the correct behavior **if** the human formally chooses a chat-only v1. It does not satisfy the original Task 13 completion criterion or the original Qoder Agent-mode goal.

---

# 7. Closure matrix

```text
ARTIFACT_INTEGRITY=PASS
REMEDIATION_4_TARGETED_DELTA=PASS
TEST_REGRESSION_SIGNAL=PASS
TYPECHECK=PASS
BUILD=PASS
SECURITY_CORE_INVARIANTS=PASS

CODEX_PROTOCOL_SCHEMA_CONFORMANCE=FAIL
CODEX_CONCURRENT_NOTIFICATION_ISOLATION=FAIL
CODEX_CONVERSATION_ROLE_SEMANTICS=FAIL
CODEX_EPHEMERAL_THREAD_REQUIREMENT=FAIL
COMMAND_CODE_NATIVE_BODY_ABORT_PROOF=FAIL
PREFLIGHT_MALFORMED_CONFIG=FAIL
LAUNCHD_RUNTIME_SMOKE=NOT_PROVEN
TASK_13_ORIGINAL_DOD=NOT_MET

LIVE_FINAL_REPROOF_AUTHORIZED=NO
FINAL_CLOSURE_ELIGIBLE=NO
```

---

# 8. Recommended next pass

Do **not** reopen Claude, Antigravity, general HTTP composition, UsageStore, bearer auth, PAYG guards or the Remediation 4 fixes.

A fifth pass should be limited to:

1. regenerate/align Codex protocol types with the stored generated schema;
2. correlate Codex notifications by thread/turn and isolate waiter timeouts;
3. preserve Codex system/user/assistant history semantics;
4. explicitly start ephemeral Codex threads;
5. fix Command Code native-fetch body abort lifetime and prove it with a local HTTP server;
6. fail preflight on malformed config;
7. close assistant `tool_calls` CHAT_ONLY edge case;
8. align LaunchAgent executable resolution + configurable secret env names and perform actual MacBook launchctl smoke when safe.

Only after a clean independent re-audit of that delta should live provider quota be used.
