# Task 13 — MCP Hardening & Provider Policy — implementation plan

**Date:** 2026-09-10
**Base HEAD:** `b439378c47c0764bb4c651e48b94bbe752c2c3f2`
**Design:** `docs/superpowers/specs/2026-09-10-task13-mcp-hardening-provider-policy-design.md`

Each task is independently testable and reviewable, and uses
**RED → minimal production fix → GREEN → adjacent regression → focused commit**.
No placeholders. No "TODO later". No fake PASS markers.

Global rules for every task:

* No live provider inference (`agy --version/--help/mcp *`, fake subprocesses,
  fake SDK, MCP stdio and Unix-socket tests only).
* If a test passes on `START_HEAD` when it should fail, do not call the defect
  fixed — inspect whether the audit was wrong, the test is weak, or the path is
  not exercised.
* Do not push, merge, or amend historical commits.

---

## Task 1 — docs: design Task 13 MCP hardening and provider policy

* Write `docs/superpowers/specs/2026-09-10-task13-mcp-hardening-provider-policy-design.md`.
* Self-review: verify every audited defect maps to a design section and every
  required marker maps to a concrete mechanism.
* Commit: `docs: design Task 13 MCP hardening and provider policy`

## Task 2 — docs: plan Task 13 MCP hardening and provider policy

* Write this plan.
* Commit: `docs: plan Task 13 MCP hardening and provider policy`

## Task 3 — test: expose Claude MCP E2E bypass (RED)

* Add `tests/providers/claude-mcp-e2e.test.ts` (new) plus
  `tests/helpers/fake-claude-sdk.ts` (protocol-faithful MCP client that consumes
  `options.mcpServers`).
* Helper behaviour: read `options.mcpServers`, spawn the configured stdio
  command with the configured `env`, `initialize` →
  `notifications/initialized` → `tools/list` → pick a declared tool →
  `tools/call` → **await** the response → derive final text from the response
  text → emit `result`. It must honour `options.abortController` by killing its
  child and ending the stream.
* The test asserts the canary causality and must **fail on `START_HEAD`** because
  production currently also spawns a duplicate bridge and the SDK config is not
  the only owner.
* Commit: `test: expose Claude MCP E2E bypass`

## Task 4 — fix: make the Claude SDK own the provider-facing MCP bridge

* Remove the manual `spawnFn(...)` provider-facing bridge from
  `src/providers/claude/adapter.ts`; remove the `spawnFn` seam and the `bridge`
  field from `LiveClaudeSession`.
* Keep exactly one `BridgeControlServer` per tool-capable request.
* Update `tests/providers/claude-bridge-roundtrip.test.ts` and
  `tests/http/tool-roundtrip-production.test.ts` to drive MCP through the fake
  SDK (Task 3 helper) instead of writing to a Router-spawned child; delete the
  `fake.release()` gates.
* Adjacent regression: `tests/providers/claude-adapter.test.ts`,
  `tests/providers/claude-deferred-bridge.test.ts`,
  `tests/providers/claude-concurrency.test.ts`,
  `tests/http/production-composition.test.ts`.
* Commit: `fix: make Claude SDK own the provider-facing MCP bridge`

## Task 5 — test: prove Claude causal MCP round-trip (GREEN)

* Strengthen `tests/providers/claude-mcp-e2e.test.ts`:
  * `CLAUDE_FAKE_SDK_CONSUMED_PRODUCTION_MCP_CONFIG=PASS`
  * `CLAUDE_FAKE_SDK_SPAWNED_CONFIGURED_MCP=PASS`
  * `CLAUDE_FAKE_SDK_SENT_TOOLS_CALL=PASS`
  * `CLAUDE_TEST_DIRECT_BRIDGE_INJECTION=NO`
  * `CLAUDE_TEST_MANUAL_RELEASE_GATE=NO`
  * `CLAUDE_MCP_RESULT_CAUSED_PROVIDER_CONTINUATION=PASS`
  * `CLAUDE_SAME_LOGICAL_RUN=PASS`
  * `CLAUDE_NATIVE_TOOL_EXECUTION=NONE`
* Asserts the provider's final text is derived **only** from the tool-result
  wire value (canary).
* Commit: `test: prove Claude causal MCP round-trip`

## Task 6 — fix: revalidate Antigravity 1.2.0 session selection

* Delete stale `AGY_VERSION` from `src/providers/antigravity/process-client.ts`;
  update `README.md` for 1.2.0.
* Rewrite `src/bridge/session-registry.ts`:
  * descriptor at `<registry>/agy-<pid>.json`, mode `0600`, dir `0700`;
  * `registerBridgeSession({ sessionId, agyPid, socketPath, token, tools })`;
  * `resolveBridgeSession(selector)` — explicit env selector or ancestor-pid
    lookup, **no directory-wide live scan**;
  * `SESSION_REGISTRY_MAX_LIVE = 64`, overflow fails closed.
* Rewrite `src/bridge/mcp-bridge-launcher.ts`: resolve the descriptor lazily with
  a bounded wait; no global discovery; fail closed on missing/stale/cross-session
  selector.
* `SpawnInferenceRunner` gains an `onSpawn(pid)` hook and an `extraEnv` option.
* RED first: `tests/bridge/session-registry.test.ts` (new) proves the current
  global scan fails two concurrent sessions and that stale/missing/cross-session
  selectors are rejected.
* Commit: `fix: revalidate Antigravity 1.2.0 session selection`

## Task 7 — test: prove concurrent Antigravity MCP sessions

* `tests/providers/antigravity-concurrency.test.ts` (new) +
  `tests/helpers/fake-agy.js` (fake agy that spawns the **real launcher** as its
  own child, drives MCP, and emits NDJSON on stdout).
* Two sessions, same tool, same arguments, overlapping lifetimes.
* Assert: A launcher → A socket only; B launcher → B socket only; A's result
  cannot release B; both complete; canary causality per session.
* Commit: `test: prove concurrent Antigravity MCP sessions`

## Task 8 — fix: bound bridge and session pending state

* `BridgeControlServer`: `pending` max 16, per-entry TTL 120 s, overflow →
  deterministic `-32000` error frame on that socket and no `onToolCall`.
  Add `pendingCount()`/`atCapacity()` accessors and an `onOverflow` diagnostic.
* Add a shared bounded async queue (`src/core/bounded-queue.ts`) with explicit
  `maxSize` and `tryPush` returning false at capacity.
* Claude + Antigravity: tool-call queue max 1; `sessions` / `toolSessions` max
  `MAX_LIVE_TOOL_SESSIONS=64`; a second concurrent call is rejected with a
  deterministic error and the session closes fail-closed.
* `StreamEventQueue` max `MAX_STREAM_EVENTS=4096` → protocol error + terminal.
* RED first: extend `tests/bridge/bridge-control.test.ts`; add
  `tests/providers/bounded-pending-state.test.ts`.
* Commit: `fix: bound bridge and session pending state`

## Task 9 — fix: enforce declared tool ACL at provider boundaries

* `src/bridge/mcp-bridge-process.ts`: `tools/call` checks
  `name ∈ declared`; else MCP error `-32602`, no control forward.
* Codex `item/tool/call`: `params.tool ∈ dynamicTools` for that thread; else
  `provider_protocol_error`, answer the wire request `success:false`, no broker
  insert.
* Command Code OpenAI wire: name ∈ `request.tools` before yielding.
* Command Code Anthropic wire: `tool_use.name` ∈ `request.tools` before yielding.
* RED first: `tests/providers/declared-tool-acl.test.ts` (new) with adversarial
  names `run_command`, `write_file`, `apply_patch`, `totally_unknown_tool`.
* Commit: `fix: enforce declared tool ACL at provider boundaries`

## Task 10 — fix: enforce provider tool choice and parallel policies

* New `src/core/tool-policy.ts` with one `enforceProviderToolPolicy(provider,
  toolChoice, parallelToolCalls)` used by **both** HTTP surfaces.
* Remove the Codex-only special case from `openai-chat.ts`; keep Codex behaviour
  identical (regression-tested).
* Claude/Google: reject `tool_choice !== "auto"` and `parallel_tool_calls === true`.
* Command Code Anthropic: exact mapping to `{type:auto|none|any|tool, …}` and
  `disable_parallel_tool_use`; reject the unrepresentable.
* Command Code OpenAI: unchanged forwarding.
* RED first: `tests/providers/tool-policy-matrix.test.ts` +
  `tests/http/chat-responses-policy-consistency.test.ts`; extend
  `tests/providers/command-code-anthropic-tools.test.ts` for the emitted body.
* Commit: `fix: enforce provider tool choice and parallel policies`

## Task 11 — fix: complete Claude provider lifecycle cancellation

* `LiveClaudeSession.activeRequestId`, `sessionsByRequest`; rebind on park and on
  continuation; `cancel(id)` aborts the live controller.
* `closeSession` order per design §3.3: TTL clear → `abort()` →
  reject pending control request → broker cancel → `iterator.return?.()` →
  `control.close()` → map cleanup.
* RED first: `tests/providers/claude-lifecycle.test.ts` (new).
* Commit: `fix: complete Claude provider lifecycle cancellation`

## Task 12 — fix: complete Antigravity provider lifecycle cancellation

* `closeToolSession` order per design §5: TTL clear → `abort()` (agy SIGINT,
  SIGKILL escalation) → reject pending → broker cancel → unregister selector →
  `control.close()` → `rmSync(cwd)` → map cleanup.
* RED first: `tests/providers/antigravity-lifecycle.test.ts` (new).
* Commit: `fix: complete Antigravity provider lifecycle cancellation`

## Task 13 — test: prove post-result cancellation matrix

* HTTP `responseCompleted` gate on both surfaces (design §3.5).
* `tests/http/production-cancellation-matrix.test.ts` (new) proving the ten
  scenarios of design §9 for Claude and Antigravity, with terminal counter
  assertions.
* Update `tests/providers/antigravity-bridge-roundtrip.test.ts` to drop the
  artificial `releaseCompletion` gate and derive its final text from the MCP
  response.
* Commit: `test: prove post-result cancellation matrix`

## Task 14 — security: harden MCP session isolation and bounds

* `tests/bridge/session-selector-security.test.ts` (new): wrong, stale, missing,
  duplicate, cross-session selectors.
* `tests/providers/session-registry-bound.test.ts` (new): overflow fail-closed.
* Extend `scripts/security-audit.sh` with static invariants: no global
  ambiguous rendezvous scan; explicit registry bound; explicit bridge pending
  bound; no test-only direct bridge hook in production; declared-tool ACL
  checks present; provider abort cleanup path present; no `0.0.0.0` bridge
  listener; no tracked bridge secret; no provider-native tool execution.
* Commit: `security: harden MCP session isolation and bounds`

## Task 15 — docs: add Task 13 MCP hardening evidence

* Write `docs/audits/2026-09-10-task13-mcp-hardening-provider-policy-evidence.md`
  with status `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT` and every required marker,
  commit hash, test path and limitation.
* Do not edit historical audit documents.
* Commit: `docs: add Task 13 MCP hardening evidence`

---

## Final gates (after Task 15)

```text
npm test            # 1
npm test            # 2
npm test            # 3
npm run typecheck
npm run build
npm test            # post-build
bash scripts/security-audit.sh
```

Then run every new MCP-hardening suite explicitly by path. No new deterministic
test may be skipped; only pre-existing genuinely live-gated provider tests may
remain skipped.

## Final stability gate

```text
git status --short     # must be clean
sleep 10
git status --short     # must be clean
git rev-parse HEAD     # must be unchanged
```

The worktree must be clean both before and after the wait, and HEAD must not
change during the wait. No repository modification after the final report.

## Acceptance

Only `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT` may be reported, never
`FINAL_CLOSED`. If any deterministic family remains incomplete, `PASS=NO` and a
truthful FAIL is mandatory.
