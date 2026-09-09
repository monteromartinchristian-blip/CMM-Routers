# CMM Subscription Router — Targeted Remediation 6 Evidence

**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`

Follow-up to `docs/audits/2026-09-09-independent-reaudit5-855599c.md`
(`AUDITED_HEAD=855599c`, verdict FAIL). This is remediation evidence, not an
independent audit. A fresh human re-audit is required.

Scope discipline: protocol/lifecycle only. Claude, Antigravity, Command Code
inference logic, HTTP architecture, UsageStore, CHAT_ONLY and PAYG guards were
not reopened. No live inference, no subscription quota burned.

## Heads and commits

- Start: `6a282fa` (contains the re-audit 5 report)
- Final: recorded at bundle time (`git log`)
- Worktree: clean at report time (`git status --porcelain` empty)

Delta commits:

- `ef62ba1` fix: use canonical Codex thread inject method
- `7c5312e` test: harden Codex protocol drift guard
- `06e3d1f` fix: fail Codex requests on malformed protocol frames and bound notification lifecycle
- `97cb620` test: prove Codex cancel isolation across concurrent runs
- `bbbd1f7` fix: share production config validation with preflight
- `4757fda` fix: fail launchd install when runtime binaries are unresolved

Deviation from the suggested commit list: re-audit 5's "malformed frames" and
"bound notification lifecycle" changes share one dispatch path
(`CodexAppServerClient.handleMessage`) and one failure path
(`failProtocol` clears the bounded buffer), so they were delivered as a single
commit rather than two artificially split ones. The delta stays narrow.

## 1 — Codex `thread/inject_items` (BLOCKER A)

Root cause: production sent `thread/injectItems` while the tracked generated
`ClientRequest` discriminator declares `thread/inject_items`
(`title: Thread/injectItemsRequest`). The scripted lifecycle test hard-coded
the same camelCase string, so test and production agreed with each other and
both disagreed with the wire contract.

Changed:
- `src/providers/codex/app-server-client.ts`: single exported constant
  `CodexAppServerClient.INJECT_ITEMS_METHOD = "thread/inject_items"` used by
  `injectItems()`.
- `src/providers/codex/adapter.ts`: stale comments corrected.
- `tests/providers/codex-conversation-lifecycle.test.ts`: the expected method
  is now derived from the generated aggregate schema
  (`Thread/injectItemsRequest`), and the wire test fails if production reverts.
- `tests/providers/codex-schema-conformance.test.ts`: new drift tests.

```text
CODEX_THREAD_INJECT_METHOD=thread/inject_items
CODEX_THREAD_INJECT_ITEMS_WIRE=PASS
CODEX_STALE_INJECTITEMS_METHOD=ABSENT
```

Remaining references to the camelCase string are three negative assertions in
tests only (`not.toContain` / `not.toBe`); production has none.

## 2 — Codex generated schema provenance

Determined with the installed local binary, no inference:

```text
codex --version                      -> codex-cli 0.153.4
codex app-server generate-json-schema --out /tmp/codex-schema-verify
diff -rq /tmp/codex-schema-verify tests/fixtures/generated/codex
  -> only extra file: PROVENANCE.json (added by this pass)
```

The tracked generated artifacts are byte-identical to a fresh generation from
the installed 0.153.4 binary, so no fixture rewrite was required. Provenance
(version, binary path, refresh command, canonical method list) is now recorded
in `tests/fixtures/generated/codex/PROVENANCE.json`.

```text
CODEX_INSTALLED_VERSION=codex-cli 0.153.4
CODEX_TRACKED_SCHEMA_VERSION=0.153.4 (byte-identical to installed output)
CODEX_SCHEMA_REFRESH_REQUIRED=NO
CODEX_SCHEMA_CURRENT_WITH_INSTALLED_BINARY=PASS
```

## 3 — Protocol drift guard validates methods, not only shapes

Root cause: the previous guard asserted only required payload keys, so it
passed while production used a nonexistent method name.

Changed `tests/providers/codex-schema-conformance.test.ts`:
- payload guard split out as `CODEX_PROTOCOL_PAYLOAD_DRIFT_GUARD`;
- new method guard reads the generated `ClientRequest.oneOf` discriminators and
  asserts production constants against them for `thread/start`,
  `thread/inject_items`, `turn/start`, `turn/interrupt`, `model/list`,
  `initialize`;
- explicit negative test that `thread/injectItems` is not a generated
  discriminator and not the production constant.

```text
CODEX_PROTOCOL_METHOD_DRIFT_GUARD=PASS
CODEX_PROTOCOL_PAYLOAD_DRIFT_GUARD=PASS
CODEX_PROTOCOL_DRIFT_GUARD=PASS
```

## 4 — Malformed Codex stdout fails closed (BLOCKER B)

Root cause: `JSON.parse` failures were silently discarded, so a corrupted
frame could leave a request pending until timeout with the wrong diagnosis.

Changed `src/providers/codex/app-server-client.ts`:
- non-JSON non-empty stdout line → `failProtocol("invalid JSON-RPC frame from
  codex app-server")`; pending requests and scoped waiters for live runs are
  rejected with `provider_protocol_error`; subsequent scoped waits fail fast;
- raw frame content is never logged or placed in the error message;
- unscoped legacy probes are not poisoned by a malformed frame.

Tests: `tests/providers/codex-app-server-client.test.ts` (scoped failure,
no content logging, concurrent cross-request isolation) and
`tests/providers/codex-conversation-lifecycle.test.ts` (adapter-level: active
run ends with a `provider_protocol_error` event, `activeTurns` empty).

```text
CODEX_MALFORMED_STDOUT=PROVIDER_PROTOCOL_ERROR
CODEX_MALFORMED_REQUEST_CLEANUP=PASS
CODEX_MALFORMED_FRAME_CROSS_REQUEST_LEAK=NONE
CODEX_MALFORMED_CONTENT_LOGGING=NONE
```

## 5 — Bounded Codex notification lifecycle (BLOCKER C)

Root cause: every unmatched notification was appended to a process-lifetime
array; `item/started` / `item/completed` carry `ThreadItem` content and were
retained forever with no consumer, and `stop()` never cleared the queue.

Changed `src/providers/codex/app-server-client.ts`:
- supported events (`item/agentMessage/delta`, `thread/tokenUsage/updated`,
  `turn/completed`) buffer in a scope-keyed buffer bounded to 64 entries
  (FIFO eviction) so a frame racing waiter registration is not lost;
- known benign events (`item/started`, `item/completed`, `turn/started`,
  `thread/started`) are discarded immediately, no payload retention;
- unknown/unawaited events are dropped metadata-only;
- delivering a `turn/completed` purges that scope's buffered frames;
- new `discardScope(scope)` releases a finished/cancelled run's buffered
  frames and stale waiters; the adapter calls it in `run()`'s `finally` and in
  `cancel()`;
- `stop()` clears the buffer.

Changed `src/providers/codex/adapter.ts`: per-run scope release; a cancelled
run now terminates silently (`signal.aborted`) instead of surfacing a
synthetic protocol error.

Tests: `tests/providers/codex-notification-isolation.test.ts` (5 000-notification
flood bounded at ≤64 with zero ignorable content; completion/cancel scope
state to 0; stale content never redelivered to another run).

```text
CODEX_UNMATCHED_NOTIFICATION_RETENTION=BOUNDED_OR_NONE
CODEX_NOTIFICATION_QUEUE_UNBOUNDED=NO
CODEX_REQUEST_SCOPED_NOTIFICATION_STATE_AFTER_COMPLETION=0
CODEX_REQUEST_SCOPED_NOTIFICATION_STATE_AFTER_CANCEL=0
CODEX_STALE_NOTIFICATION_REDELIVERY=NONE
CODEX_CROSS_REQUEST_CONTENT_LEAK=NONE
CODEX_UNBOUNDED_CONTENT_RETENTION=NONE
```

## 6 — Concurrent cancel A/B proof (Finding D)

New `tests/providers/codex-concurrent-cancel.test.ts` drives two simultaneous
runs through the real `CodexAdapter` + `CodexAppServerClient` against a
scripted schema-shaped app-server: A→thread-A/turn-A, B→thread-B/turn-B,
interleaved deltas, then `abort(A)` + `adapter.cancel("req-A")`.

Asserted: exactly one `turn/interrupt` with `thread-A`/`turn-A`; B keeps
receiving deltas and completes; no A waiter, active turn, or buffered
notification remains. Negative control: disabling scoped release in `cancel()`
makes the test fail (A never terminates), so the proof is load-bearing.

```text
CODEX_CANCEL_A_TARGET_THREAD=thread-A
CODEX_CANCEL_A_TARGET_TURN=turn-A
CODEX_REQUEST_A_ABORTED=YES
CODEX_REQUEST_B_CONTINUES=YES
CODEX_REQUEST_B_COMPLETES=YES
CODEX_CANCEL_AFFECTED_B=NO
CODEX_CANCEL_SCOPING=PASS
CODEX_CANCEL_A_STATE_CLEANUP=PASS
```

## 7 — Preflight uses the production schema (Finding E)

Root cause: `scripts/preflight.sh` maintained a partial handwritten
JSON/key validator that accepted configs production rejects (e.g. missing
required `mode`).

Changed:
- new `scripts/validate-config.mjs`: the single authoritative Node entrypoint.
  It imports the SAME `sharedConfigSchema` / `localConfigSchema` used by
  `loadConfig()` (TS source when the runtime supports it, else the compiled
  `dist/config/schema.js`), emits status-safe lines only (booleans, env NAMES,
  configured paths), and reduces Zod issues to paths+codes so no config
  content leaks. Exit codes: 0 valid, 1 invalid, 2 unavailable, 3 missing.
- `scripts/preflight.sh`: all config constraints removed; it consumes the
  validator. Invalid/unavailable → `CONFIG=INVALID`/`CONFIG=UNAVAILABLE` and
  rc 1. Missing file keeps the documented bootstrap defaults.
- `tests/integration/preflight-schema-equivalence.test.ts` (12 tests): for
  missing `mode`, invalid host, invalid port (range and type), invalid
  provider structure, unknown key, invalid command-code `secretEnv`, invalid
  claude `profileDir` type, invalid google `agyPath` type, malformed JSON and
  a valid control, production `loadConfig`/`sharedConfigSchema` and preflight
  agree; plus a no-duplicate-schema assertion.

```text
PREFLIGHT_PRODUCTION_SCHEMA_EQUIVALENCE=PASS
PREFLIGHT_DUPLICATE_CONFIG_SCHEMA=NONE
```

## 8 — Launchd installer fails closed (Finding F)

Root cause: `command -v node || echo node` (and the same for codex/agy) could
bake bare names into the LaunchAgent, producing a plist that predictably fails.

Changed `scripts/macos/install-router.sh`:
- `resolve_executable()` returns an executable absolute path or fails;
- node always required; codex required only when ChatGPT is enabled; agy
  required only when Google is enabled (configured `agyPath` authoritative,
  then `CMM_ROUTER_AGY_BIN`, then PATH, then `~/.local/bin/agy`);
- unresolved enabled runtime → `error: ... refusing to install`, exit 1, no
  plist written;
- enablement comes from `scripts/validate-config.mjs` (no second config
  parser); invalid config aborts the install;
- Command Code is HTTP-based and requires no local binary;
- `CMM_CONFIG_DIR` is now honored for the bootstrap and validation source,
  consistent with `preflight.sh` and `run-router.sh`.

Tests: `tests/integration/launchd-fail-closed.test.ts` (7 tests) plus the
existing deterministic suite.

```text
LAUNCHD_MISSING_NODE=FAIL_CLOSED
LAUNCHD_MISSING_CODEX_WHEN_ENABLED=FAIL_CLOSED
LAUNCHD_MISSING_AGY_WHEN_ENABLED=FAIL_CLOSED
LAUNCHD_DISABLED_PROVIDER_BINARY_NOT_REQUIRED=PASS
LAUNCHD_BARE_NODE_FALLBACK=NONE
LAUNCHD_BARE_CODEX_FALLBACK=NONE
```

## 9 — Task 13 truthfulness (unchanged)

```text
TASK_13_ORIGINAL_DOD=NOT_MET
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
PROVIDER_CAPABILITIES=chatgpt/CHAT_ONLY claude/CHAT_ONLY google/CHAT_ONLY command-code/CHAT_ONLY
```

No provider-native tools were implemented, no tool rejection weakened, no
scope reinterpretation. `tests/providers/capability-truthfulness.test.ts` green.

## Verification (deterministic, no live quota)

```text
TEST_FILES=72 (67 passed, 5 skipped)
TESTS=424 (399 passed, 25 skipped)
TEST_RUN_1=PASS
TEST_RUN_2=PASS
TEST_RUN_3=PASS
TYPECHECK=PASS
BUILD=PASS
POST_BUILD_TEST=PASS
SECURITY_AUDIT=PASS
TARGETED (7 files, 75 tests)=PASS
PAYG_PROBES: OPENAI_RC=1, ANTHROPIC_RC=1, GEMINI_RC=1
LIVE_TESTS_RUN=NO
```

Targeted command used explicit file paths (no shell word-splitting):

```bash
npx vitest run \
  tests/providers/codex-schema-conformance.test.ts \
  tests/providers/codex-conversation-lifecycle.test.ts \
  tests/providers/codex-notification-isolation.test.ts \
  tests/providers/codex-concurrent-cancel.test.ts \
  tests/providers/codex-app-server-client.test.ts \
  tests/integration/preflight-schema-equivalence.test.ts \
  tests/integration/launchd-fail-closed.test.ts
```

## Security re-scan

```text
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
NO_UNSAFE_FLAGS=PASS
LOG_HYGIENE=PASS
CONTENT_LOGGING=NONE (no console.* in src/providers/codex)
TOOL_BODY_LOGGING=NONE
NO_OAUTH_EXTRACTION=PASS / NO_OAUTH_COPY=PASS / NO_OAUTH_SYNC=PASS
  (only occurrences are the wire-level forbidden-key rejection list in src/core/wire.ts)
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE / COMMAND_CODE_AUTO_TOP_UP=NONE
```

## Remaining limitations

- Independent human re-audit is still required; this report is not a PASS.
- No live Codex multi-turn reproof was run (no quota burned). The wire method,
  schema shapes, drift guard and lifecycle behavior are proven against the
  tracked generated 0.153.4 schema and scripted app-servers only.
- `launchctl bootstrap` runtime smoke remains `BLOCKED_TEST_ENVIRONMENT`.
- The installer now requires a valid shared config and (on Node < 22.6 without
  a build) the compiled `dist/config/schema.js` to resolve enablement; an
  unresolvable schema fails closed rather than guessing.
- Task 13 DoD remains NOT_MET by design; the scope decision is the human's.
