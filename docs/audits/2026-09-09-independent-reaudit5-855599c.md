# CMM Subscription Router — Independent Re-audit 5

**Date:** 2026-09-09
**Audited HEAD:** `855599c90aa2d6a8ac6785bf8bb8204c65f1f3b6`
**Baseline report commit:** `1975c05`
**Verdict:** `FAIL`
**Live final reproof authorized:** `NO`

## 1. Integrity

The supplied archive is a real `git archive` of the requested commit.

```text
AUDITED_HEAD=855599c90aa2d6a8ac6785bf8bb8204c65f1f3b6
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=788ede8ff45bedd131d87d714eb017a95bf9843fa872f956bfc7bb851df1ecb5
LOG_SHA256=629b8b0261393a7a6c14d54012c80a78217f2d22f3ed75ab946648f01d15ce5f
WORKTREE_CAPTURE=CLEAN
```

`gzip -t` passed and `git get-tar-commit-id` returned the exact audited HEAD.

## 2. Verification capture

The broad deterministic signal is strong:

```text
FULL_TEST_RUN_1=PASS   372 passed / 25 skipped
FULL_TEST_RUN_2=PASS   372 passed / 25 skipped
FULL_TEST_RUN_3=PASS   372 passed / 25 skipped
POST_BUILD_TEST=PASS   372 passed / 25 skipped
TYPECHECK=PASS
BUILD=PASS
SECURITY_AUDIT=PASS
ACTUAL_DIST_PROCESS=PASS
SOCKET_DISCONNECT=PASS
OPENAI_PAYG_POISON=PASS (expected rc=1)
ANTHROPIC_PAYG_POISON=PASS (expected rc=1)
GOOGLE_PAYG_POISON=PASS (expected rc=1)
```

The three targeted capture commands returned `RC=1` because the audit capture was launched from zsh and the generated whitespace-separated file list was not split into separate argv elements. Vitest therefore received the whole list as one filter. This is an **audit-command defect, not a repository defect**. The same targeted tests executed successfully as part of each complete suite.

Likewise, the ad-hoc malformed-config probe in the capture used `CMM_ROUTER_CONFIG`, while the repository's supported override is `CMM_CONFIG_DIR`; its `rc=1` therefore came from normal provider state and is not independent proof of malformed-config handling. The repository's dedicated malformed-config tests do exercise `CMM_CONFIG_DIR` correctly.

## 3. Remediation 5 findings genuinely fixed

Independent source inspection confirms the following changes are substantive:

### 3.1 Codex turn/result schema parsing — PASS

Production now parses `turn/start` from `result.turn.id`, token usage from nested `tokenUsage`, and completion from `{ threadId, turn }`. Empty turn IDs are rejected before `turn/interrupt`.

### 3.2 Codex scoped notification matching — PASS, with lifecycle caveat below

`NotificationWaiter` now carries optional `threadId`/`turnId`, and `waiterMatches()` correlates method + identifiers, including nested `turn.id` for completion. The A/B interleave test exercises the real production dispatcher and demonstrates no cross-thread delta/usage/completion delivery.

### 3.3 Codex role preservation / ephemeral thread — PASS in construction

Production now maps system content to `developerInstructions`, previous user/assistant messages to Responses-style history items, and the latest user message to `turn/start`. `ephemeral: true` is explicitly sent on `thread/start`.

### 3.4 Command Code native abort — PASS

The native `fetch` receives the composed operation signal for the response lifecycle. The new test uses a real local HTTP server, sends headers + one chunk, stalls, then proves both Router timeout and server-observed connection teardown.

### 3.5 CHAT_ONLY assistant tool history — PASS

The HTTP boundary now rejects assistant tool-call history before provider invocation.

### 3.6 Launchd deterministic paths / configured secret names — substantially PASS

The installer resolves Node/Codex paths on the current machine, respects configured `agyPath`, and the wrapper resolves configured secret environment **names** without storing secret values in tracked files.

---

# 4. BLOCKER A — Codex history injection uses the wrong JSON-RPC method

This is the decisive blocker.

Production currently sends:

```text
thread/injectItems
```

from:

```text
src/providers/codex/app-server-client.ts
```

The repository's **own tracked generated aggregate schema** declares the method as:

```text
thread/inject_items
```

Evidence inside the audited tree:

```text
src/providers/codex/app-server-client.ts:330
  sendRequest("thread/injectItems", ...)

tests/fixtures/generated/codex/codex_app_server_protocol.schemas.json:887
  "thread/inject_items"
```

The new conversation-lifecycle test is scripted to accept the incorrect camelCase method, so the test and implementation agree with one another while both disagree with the generated wire contract.

The current Codex 0.153.4 protocol also exposes `ThreadInjectItems` as `thread/inject_items`.

### Consequence

A single-turn Codex request can still work because it does not need injected history. A real multi-turn request with previous user/assistant history will attempt the incorrect method before `turn/start` and is expected to fail at the app-server boundary.

Therefore:

```text
CODEX_PROTOCOL_SCHEMA_CONFORMANCE=FAIL
CODEX_MULTI_TURN_WIRE_COMPATIBILITY=FAIL
CODEX_PROTOCOL_DRIFT_GUARD=FALSE_POSITIVE
```

### Required remediation

1. Refresh the generated schema from the **actually installed Codex binary** used by the Router.
2. Record the exact generated Codex version/commit alongside fixtures.
3. Use `thread/inject_items` from the generated request discriminator.
4. Extend the drift guard to validate **method discriminators**, not only payload required keys.
5. Make the scripted lifecycle test derive/verify the method name from the generated aggregate schema rather than hard-code the production string.

---

# 5. BLOCKER B — malformed Codex stdout is still silently discarded

The implementation plan explicitly requires:

```text
Malformed JSON from stdout must become provider_protocol_error.
```

Current production code instead does:

```ts
try {
  message = JSON.parse(raw);
} catch {
  return;
}
```

and the existing test explicitly asserts:

```text
"ignores malformed JSON without crashing"
```

This is not merely missing coverage; the test suite currently locks in behavior opposite to the agreed DoD.

### Why it matters

A corrupted/truncated/mixed app-server frame can be silently lost. If the dropped frame is a response or terminal event, the associated request can remain pending or time out with the wrong diagnosis instead of failing immediately as a protocol error.

Required:

```text
CODEX_MALFORMED_STDOUT_FAILS_PROTOCOL=PASS
```

The client should fail the affected connection/run safely without logging raw content.

---

# 6. BLOCKER C — Codex notification queue is unbounded and can retain conversation content

`CodexAppServerClient` currently has a process-lifetime array:

```ts
private notificationQueue: JSONRPCNotification[] = [];
```

Every notification with no matching waiter is appended:

```ts
this.notificationQueue.push(notification);
```

The adapter only consumes three methods:

```text
item/agentMessage/delta
thread/tokenUsage/updated
turn/completed
```

But the tracked/current app-server protocol includes many other normal turn notifications, including:

```text
item/started
item/completed
turn/started
thread/started
...
```

`item/started` and `item/completed` contain a `ThreadItem`. `ThreadItem` can contain user message content, full agent message text, reasoning text, command metadata, etc.

Those notifications have no consumer in the Router and therefore can remain in `notificationQueue` indefinitely. `stop()` also does not clear `notificationQueue`.

### Consequences

- unbounded memory growth in a long-lived LaunchAgent;
- unnecessary retention of user/assistant content in memory;
- stale notifications surviving across subsequent Router requests;
- privacy posture weaker than intended for ephemeral threads.

Required design:

- do not globally queue every server notification;
- queue only explicitly supported/awaited event classes, or use per-run bounded queues;
- discard unsupported benign notifications immediately without logging content;
- fail closed on security-relevant unsupported server requests;
- clear per-run queues on completion/cancel/error;
- add a bounded-queue/content-retention regression.

Required markers:

```text
CODEX_NOTIFICATION_QUEUE_BOUNDED=PASS
CODEX_UNCONSUMED_CONTENT_RETENTION=NONE
CODEX_QUEUE_CLEAN_AFTER_RUN=PASS
```

---

# 7. Finding D — cancellation concurrency claim is under-tested

The Remediation 5 specification explicitly required:

```text
cancel A → turn-A
B remains active/unaffected
```

The new concurrency test proves event delivery isolation, but it never cancels A. Cancellation is tested separately with a single request.

Production code appears directionally correct because `activeTurns` is keyed by Router `requestId`, but the required concurrent cancellation proof is absent.

This is an evidence gap rather than a demonstrated cross-request bug.

Required deterministic test:

```text
A=thread-A/turn-A
B=thread-B/turn-B
cancel(A)
→ only turn/interrupt(thread-A,turn-A)
→ B continues to receive B deltas and completes normally
```

---

# 8. Finding E — preflight is not actually equivalent to the production Zod schema

Remediation 5 correctly catches malformed JSON and the tested `bad host + unknown top-level key` case, but `scripts/preflight.sh` still implements a partial handwritten validator.

Independent reproduction against the audited bundle:

Input `shared.json`:

```json
{
  "host": "127.0.0.1",
  "providers": {
    "chatgpt": {"enabled": false},
    "claude": {"enabled": false},
    "google": {"enabled": false},
    "command-code": {"enabled": false, "secretEnv": "COMMAND_CODE_SECRET"}
  }
}
```

This is invalid under production `sharedConfigSchema` because required `mode` is absent.

Independent preflight result:

```text
CONFIG=VALID
PREFLIGHT=PASS
RC=0
```

The shell validator also does not reproduce all Zod constraints for port type/range, nested provider strictness, required provider keys, and other schema details.

Therefore:

```text
PREFLIGHT_MALFORMED_JSON=PASS
PREFLIGHT_FULL_SCHEMA_EQUIVALENCE=FAIL
```

Preferred fix: expose one tiny Node config-validation command that imports the same `sharedConfigSchema`/`loadConfig` path used by production, and let `preflight.sh` consume only its status-safe output. Avoid maintaining a second schema in Python/bash.

---

# 9. Finding F — launchd installer does not fail closed when executables are unresolved

`install-router.sh` uses fallbacks such as:

```text
command -v node || echo node
command -v codex || echo codex
```

So the installer can still render a supposedly deterministic LaunchAgent with a bare `node` or `codex` when resolution fails.

The current-machine test demonstrates absolute paths when those binaries exist, but does not prove the installer fails when an enabled required runtime is absent.

This is not a blocker for the current MacBook if its binaries are present, but it remains a Task 17 reproducibility/installation closure issue for the iMac.

Desired behavior:

```text
enabled provider/runtime + unresolved executable
→ installer exits non-zero
→ no misleading plist success
```

---

# 10. Regression/security assessment

No regression was found in the previously closed core areas:

```text
COMMAND_CODE_NATIVE_ABORT=PASS
CHAT_ONLY_TOOL_BOUNDARY=PASS
CLAUDE_STREAMING=PASS
CLAUDE_CONTEXT=PASS
ANTIGRAVITY_STREAMING=PASS
ANTIGRAVITY_CONTEXT=PASS
PAYG_POISON_GUARDS=PASS
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
HTTP_SOCKET_CANCEL=PASS
FRESH_CLONE_BOOTSTRAP=PASS
```

The recurring Codex `models_manager` timeout messages in the captured test output are noisy but did not cause suite failure; they are not treated as a new blocker in this audit.

Task 13 remains truthfully unresolved:

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=CHAT_ONLY
```

---

# 11. Verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_REAUDIT_5=FAIL

AUDITED_HEAD=855599c90aa2d6a8ac6785bf8bb8204c65f1f3b6
ARCHIVE_COMMIT_MATCH=YES
REGRESSION_SIGNAL=STRONG
REMEDIATION_5_TARGETED_DELTA=PARTIAL_PASS

CODEX_TURN_SCHEMA_PARSING=PASS
CODEX_NOTIFICATION_THREAD_TURN_FILTERING=PASS
CODEX_ROLE_CONSTRUCTION=PASS
CODEX_EPHEMERAL_THREAD=PASS
COMMAND_CODE_NATIVE_ABORT=PASS
CHAT_ONLY_ASSISTANT_TOOL_HISTORY=PASS

CODEX_CURRENT_METHOD_CONFORMANCE=FAIL
CODEX_MULTI_TURN_HISTORY_WIRE=FAIL
CODEX_PROTOCOL_DRIFT_GUARD=FAIL
CODEX_MALFORMED_STDOUT_FAIL_CLOSED=FAIL
CODEX_NOTIFICATION_QUEUE_LIFECYCLE=FAIL
PREFLIGHT_FULL_SCHEMA_EQUIVALENCE=FAIL
LAUNCHD_MISSING_EXECUTABLE_FAIL_CLOSED=NOT_PROVEN

TASK_13_ORIGINAL_DOD=NOT_MET
LIVE_FINAL_REPROOF_AUTHORIZED=NO
FINAL_CLOSURE_ELIGIBLE=NO

NEXT=TARGETED_REMEDIATION_6_PROTOCOL_LIFECYCLE_ONLY
```

## 12. Scope of the next delta

Do **not** reopen Claude, Antigravity, Command Code inference logic, HTTP, UsageStore, bootstrap, or PAYG.

The next delta should be limited to:

1. regenerate Codex schema from the installed Router binary and pin provenance;
2. fix `thread/inject_items` and method-discriminator drift coverage;
3. fail Codex malformed stdout as `provider_protocol_error`;
4. replace the global unbounded notification queue with bounded/per-run lifecycle-safe handling;
5. add the missing concurrent cancel-A/B proof;
6. make preflight call the real production config schema;
7. make launchd installer fail closed on unresolved enabled executables.

After that delta, repeat only targeted deterministic verification. If clean, proceed directly to minimal credentialed live reproof.
