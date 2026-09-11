# Task 13 — Final Protocol Edge Hardening (Evidence)

**Date:** 2026-09-10
**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`
**Design:** `docs/superpowers/specs/2026-09-10-task13-final-protocol-edge-hardening-design.md`
**Plan:** `docs/superpowers/plans/2026-09-10-task13-final-protocol-edge-hardening-plan.md`

```text
START_HEAD=3dc457497e749425766e71d82f2c39f83f5c25bb
FINAL_HEAD=6a5629cca9cb582dbe5ffb2cbebf69f6fda666d8
```

`FINAL_HEAD` is the audited code state. This evidence document is committed on
top of it as a documentation-only commit (the audited implementation state is
its direct parent), matching the precedent of the previous cycle.

Input: the independent re-audit of `516ccdd`
(`docs/audits/2026-09-10-independent-task13-mcp-hardening-reaudit-516ccdd.md`,
verdict FAIL). Every finding was independently re-derived; source + behaviour
decided, not the audit text.

All work is deterministic. **No live provider inference was run in this pass.**

---

## 1. Commit list (focused, unsquashed; no historical commit amended, no push)

```text
2001c26 docs: design Task 13 final protocol edge hardening
02be0a9 docs: plan Task 13 final protocol edge hardening
88ba1e2 fix: normalize API-specific named tool choice and make provider policy literal
ef6a289 security: bound provider-facing MCP stdio and require valid JSON-RPC tool requests
1154876 fix: reconcile Antigravity registry and MCP registration across restarts
6b75eba fix: fail closed on Antigravity overflow, guarantee abort termination, bound raw output
e4914c2 feat: support repeated Antigravity MCP tool calls in one agy run
441d1ff test: prove Router-level Antigravity two-step agent loop
59d1ee9 test: prepare minimal live canary scripts for Task 13 providers
b53c512 test: cover Antigravity cancellation while waiting for a tool result
a75c9a3 feat: support repeated Codex external tool calls in one turn
19da686 feat: support repeated Claude MCP tool calls in one session
1c462bf test: prove Command Code two-step tool loops on both wires
e75cb53 security: bound remaining provider-controlled stream buffers and surface body errors
6a5629c test: widen live-SDK timeout budget for load-sensitive Claude cases
```

15 commits on top of `START_HEAD`. The plan's suggested order was adjusted only
where file coupling required it (the Antigravity adapter carries overflow +
termination + raw-buffer + registration-integration in one file).

## 2. Exact files changed (`git diff --name-status 3dc4574..HEAD`)

Production:

```text
M src/bridge/mcp-bridge-process.ts
M src/bridge/session-registry.ts
M src/core/model.ts
M src/core/tool-policy.ts
M src/http/openai-chat.ts
M src/http/openai-responses.ts
A src/providers/antigravity/mcp-registration.ts
M src/providers/antigravity/adapter.ts
M src/providers/antigravity/process-client.ts
M src/providers/claude/adapter.ts
M src/providers/claude/mcp-bridge.ts
M src/providers/codex/adapter.ts
M src/providers/command-code/adapter.ts
M src/providers/command-code/client.ts
```

Tests / fixtures / scripts:

```text
A tests/bridge/mcp-bridge-process-bounds.test.ts
A tests/bridge/session-registry-restart.test.ts
A tests/helpers/fake-agy-multistep.js
A tests/helpers/fake-claude-sdk-multistep.ts
A tests/helpers/ignore-sigint-provider.js
A tests/helpers/mcp-bridge-entry.ts
A tests/helpers/oversize-line-provider.js
A tests/http/antigravity-multistep-tool-loop.test.ts
A tests/http/claude-multistep-tool-loop.test.ts
A tests/http/codex-multistep-tool-loop.test.ts
A tests/http/command-code-multistep-tool-loop.test.ts
A tests/http/tool-choice-wire-normalization.test.ts
A tests/providers/antigravity-mcp-registration.test.ts
A tests/providers/antigravity-multistep-tool-loop.test.ts
A tests/providers/antigravity-protocol-hardening.test.ts
A tests/providers/claude-multistep-tool-loop.test.ts
A tests/providers/codex-multistep-tool-loop.test.ts
A tests/providers/command-code-anthropic-two-step.test.ts
A tests/providers/command-code-openai-two-step.test.ts
A tests/providers/command-code-sse-frame-bound.test.ts
A tests/providers/mcp-bridge-frame-bound.test.ts
M tests/http/tool-choice-forwarding.test.ts
M tests/http/tool-policy-rejection.test.ts
M tests/providers/claude-adapter.test.ts
M tests/providers/command-code-openai-body.test.ts
M tests/providers/tool-policy-matrix.test.ts
A scripts/live-canary/canary-{claude,antigravity,codex,command-code}.sh
A scripts/live-canary/canary-lib.sh
```

---

## 3. P0 #1 — API-specific `tool_choice` normalization

**Defect (confirmed).** The single `normalizeToolChoice()` accepted only the Chat
Completions named-function shape `{type:"function",function:{name}}`. Both HTTP
surfaces shared it, so the canonical Responses shape `{type:"function",name}`
returned `invalid_request` at `/v1/responses`.

**Production behaviour now.** Wire parsing is separated from internal policy:

```text
parseChatToolChoice(raw)       -> ToolChoicePolicy   (Chat nested shape)
parseResponsesToolChoice(raw)  -> ToolChoicePolicy   (Responses flat shape)
ToolChoicePolicy = auto | none | required | {kind:"named",name}
enforceProviderToolPolicy(provider, policy, parallelToolCalls)
```

Provider policy consumes only the normalized form and never learns which public
API produced it. `RouterRequest.toolChoice` carries the normalized policy, so the
Command Code Anthropic mapper also consumes the normalized form. Each parser
strictly rejects the other endpoint's shape.

**RED observed (before fix).**
- `Responses surface accepts the literal FLAT named-function shape` →
  `AssertionError: expected 400 to be 200`.
- `normalizes each surface's own named-function wire shape before provider policy`
  → `expected 'invalid_request' to be 'unsupported_capability'`.

**GREEN.** `tests/http/tool-choice-wire-normalization.test.ts` passes:
`CHAT_NAMED_FUNCTION_TOOL_CHOICE_WIRE=PASS`,
`RESPONSES_NAMED_FUNCTION_TOOL_CHOICE_WIRE=PASS`,
`CHAT_RESPONSES_TOOL_CHOICE_NORMALIZE_TO_SAME_INTERNAL_VALUE=PASS`,
`RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=PASS`.
Both parsers are exercised with each endpoint's literal wire object; no shared
malformed object is reused.

## 4. P0 #2 — Antigravity stream overflow is terminal

**Defect (confirmed).** `StreamEventQueue.push()` set `overflowed=true` and
silently discarded the event; `didOverflow()` had no production consumer.

**Behaviour now.** Overflow atomically: discards buffered events, refuses all
further provider events, records one bounded `provider_protocol_error`, wakes the
consumer, and invokes an `onOverflow` callback that aborts the exact agy run. The
drain loops surface the protocol error exactly once, emit no successful
completion afterwards, and run the normal cleanup. The queue capacity is
injectable (`maxStreamEvents`).

**RED observed.** With a tiny queue and a flooding provider the pre-fix adapter
never produced a protocol error (test timed out / no error event).

**GREEN.** `tests/providers/antigravity-protocol-hardening.test.ts`:
`ANTIGRAVITY_STREAM_QUEUE_BOUND=PASS`,
`ANTIGRAVITY_STREAM_OVERFLOW_OBSERVED=PASS`,
`ANTIGRAVITY_STREAM_OVERFLOW_PROVIDER_ABORT=PASS`,
`ANTIGRAVITY_STREAM_OVERFLOW_PROTOCOL_ERROR=PASS`,
`ANTIGRAVITY_STREAM_OVERFLOW_SUCCESS_AFTER_ERROR=NONE`,
`ANTIGRAVITY_STREAM_OVERFLOW_CLEANUP=PASS` (active tool sessions 0, rendezvous 0,
broker 0).

## 5. P0 #3 — One child-termination primitive (SIGINT → grace → SIGKILL)

**Defect (confirmed).** The timeout path did SIGINT→2 s→SIGKILL; the ordinary
`AbortSignal` path sent SIGINT only.

**Behaviour now.** `terminateChild()` in `process-client.ts` is the single
primitive used by timeout, `AbortSignal`, oversize-line fail-closed, and (through
`abortController`) TTL cleanup, post-result cancellation, protocol failure,
bridge failure and teardown:

```text
SIGINT -> bounded grace (default 2000 ms) -> SIGKILL -> settle on "close"
(stdout drained) or a bounded terminal verdict
```

It settles on `close`, never the earlier `exit`, so the final diagnostic output is
observable. Timers are cleared on every settle path; no duplicate signal race
(one lazily-created termination promise per run).

**Fixture.** `tests/helpers/ignore-sigint-provider.js` deliberately ignores SIGINT
and writes a `SIGINT_SEEN` frame — verified directly to survive SIGINT.

**RED observed.** Pre-fix abort reported `signal='SIGINT'` (only SIGINT sent); the
oversize-line case hung.

**GREEN.** `tests/providers/antigravity-protocol-hardening.test.ts`, real
`SpawnInferenceRunner` + real local child:
`AGY_ABORT_SIGINT_SENT=PASS`, `AGY_ABORT_GRACE_PERIOD_BOUNDED=PASS` (≥250 ms,
<5 s), `AGY_ABORT_SIGKILL_ESCALATION=PASS` (`close` signal `SIGKILL`),
`AGY_ABORT_CHILD_EXIT_OBSERVED=PASS`, `AGY_ABORT_PROCESS_EXIT=PASS`,
`AGY_TIMEOUT_SIGKILL_ESCALATION=PASS`,
`ANTIGRAVITY_TTL_GUARANTEES_PROVIDER_PROCESS_EXIT=PASS`,
`ANTIGRAVITY_POST_RESULT_CANCEL_GUARANTEES_PROVIDER_PROCESS_EXIT=PASS`
(both against the real runner and a real provider process, asserting the pid is
gone).

## 6. P0 #4 — Bound the provider-facing MCP stdio parser

**Defect (confirmed).** `mcp-bridge-process.ts` appended stdin into an unbounded
`buffer` before any newline.

**Behaviour now.** `MAX_MCP_STDIO_FRAME_BYTES = 1 MiB` (consistent with
`MAX_CONTROL_FRAME_BYTES` and the 1 MiB tool-result bound), enforced WHILE
accumulating (retained + chunk checked before appending), not only at newline. On
overflow: discard retained frame state, never forward a control-channel request,
emit a JSON-RPC error (`id:null`, `-32700`, "MCP frame exceeds maximum size"),
flush and exit non-zero so the provider session is torn down. The frame pipeline
was extracted into `createMcpStdioParser` used by the real
`startMcpBridgeProcess` (no test-only bypass).

**RED observed.** 25/25 new cases failed pre-fix, e.g. the e2e oversize-frame case
`waitFor timed out` (no exit, no error frame).

**GREEN.** `tests/bridge/mcp-bridge-process-bounds.test.ts`:
`MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=PASS`,
`MCP_OVERSIZE_FRAME_FAIL_CLOSED=PASS`,
`MCP_OVERSIZE_FRAME_SURFACED_TO_QODER=NONE`.

## 7. P0 #5 — `tools/call` must be a valid JSON-RPC request

**Defect (confirmed).** A `tools/call` frame without `jsonrpc:"2.0"` and/or without
a valid `id` could still validate a declared tool and create an executable Qoder
call. Malformed JSON was silently `continue`d.

**Behaviour now.** Before any control-channel call, ALL are required:
`jsonrpc==="2.0"`, `id` string|number, `method==="tools/call"`, `params` object,
`params.name` a declared tool, `params.arguments` object-shaped. Anything else
fails closed and creates no Router/broker/tool state. Deliberate malformed-frame
policy: JSON parse failure → `-32700` with `id:null`, then terminate fail-closed
(no indefinite `catch{continue}`).

**GREEN.** `tests/bridge/mcp-bridge-process-bounds.test.ts`:
`MCP_TOOL_CALL_JSONRPC_VERSION_REQUIRED=PASS`,
`MCP_TOOL_CALL_JSONRPC_ID_REQUIRED=PASS`,
`MCP_MALFORMED_TOOL_CALL_FAIL_CLOSED=PASS`,
`MALFORMED_MCP_TOOL_CALL_SURFACED_TO_QODER=NONE`, plus adversarial cases (missing
jsonrpc, wrong version, missing/null/object id, missing params, missing name,
undeclared name, malformed arguments, duplicate in-flight id) each asserting no
control request was made, and a positive control that a well-formed call reaches
the control channel exactly once.

## 8. P0 #6 — Bound raw agy process output

**Defect (confirmed).** `SpawnInferenceRunner` appended `stdout`, `stderr` and the
partial NDJSON `lineBuffer` unbounded.

**Behaviour now.**
`MAX_AGY_STDOUT_DIAGNOSTIC_BYTES = 64 KiB`,
`MAX_AGY_STDERR_DIAGNOSTIC_BYTES = 64 KiB` via `CappedTextBuffer` (bounded
head+tail window, `didOverflow()` observable; diagnostics only — inference text
still comes from the parsed event stream), and
`MAX_AGY_NDJSON_LINE_BYTES = 1 MiB` for the unterminated line. An NDJSON line
beyond the bound → `provider_protocol_error` event, provider abort, no successful
completion. Memory never grows with provider lifetime.

**RED observed.** The oversize-line probe hung pre-fix (no protocol error, no
exit).

**GREEN.** `tests/providers/antigravity-protocol-hardening.test.ts`:
`AGY_STDOUT_ACCUMULATOR_BOUNDED=PASS`, `AGY_STDERR_ACCUMULATOR_BOUNDED=PASS`,
`AGY_NDJSON_PARTIAL_LINE_BOUNDED=PASS`, `AGY_OVERSIZE_NDJSON_FAIL_CLOSED=PASS`.

Additionally (adversarial review of "unbounded string append"): the legacy
provider-facing library `src/providers/claude/mcp-bridge.ts` now enforces the same
1 MiB frame bound and exits non-zero on overflow —
`MCP_BRIDGE_LIBRARY_STDIO_FRAME_BOUND=PASS`,
`MCP_BRIDGE_LIBRARY_OVERSIZE_FRAME_FAIL_CLOSED=PASS` (child-process test,
RED = timeout → GREEN = exit 1). The Command Code upstream SSE residual buffer is
bounded at 1 MiB (`MAX_PROVIDER_SSE_FRAME_BYTES`) —
`COMMAND_CODE_SSE_FRAME_BOUND=PASS`,
`COMMAND_CODE_OVERSIZE_SSE_FRAME_FAIL_CLOSED=PASS`. Fixing the latter exposed a
real silent-failure defect: the abort-aware `live()` iterator converted every body
error into a clean "closed" and swallowed it; it now records and re-throws the
source error when the caller has not aborted.

## 9. P0 #7 — Restart-safe registry + MCP registration

**Defect (confirmed).** The capacity check counted only the in-process Map; stale
on-disk descriptors survived restart and two Router processes could each believe
they were below 64. `agy mcp add` idempotence was remembered only in one process.

**Behaviour now.**
- `BridgeSessionRegistry.register` reconciles the on-disk registry before each
  registration: malformed and stale descriptors (dead owner pid or missing control
  socket) are removed; verified-live descriptors are never removed; the bound is
  enforced against the EFFECTIVE registry (disk ∪ memory) under an exclusive
  directory lock (atomic `wx` create, bounded acquire timeout, stale-lock
  recovery) so concurrent Router processes cannot jointly exceed
  `SESSION_REGISTRY_MAX_LIVE = 64`.
- `src/providers/antigravity/mcp-registration.ts`
  (`ensureAntigravityMcpRegistration` / `reconcileAntigravityMcpRegistration`)
  reads real `agy mcp list` output and converges `cmm-qoder-tools` to exactly one
  canonical, enabled, secret-free registration with the correct command/args,
  repairing idempotently. Integrated into the adapter
  (`ensureMcpServerRegistered`), with the test-injection seam preserved.

**RED observed.** `tests/bridge/session-registry-restart.test.ts` 5 failed / 1
passed pre-fix (stale not removed, no effective bound, no lock, malformed kept);
the registration suite failed to import the missing module.

**GREEN.** `SESSION_REGISTRY_STALE_DESCRIPTOR_RECONCILIATION=PASS`,
`SESSION_REGISTRY_EFFECTIVE_DISK_BOUND=PASS`,
`SESSION_REGISTRY_MULTI_PROCESS_RACE_FAIL_CLOSED=PASS`,
`SESSION_REGISTRY_MAX_LIVE=64` (default),
`ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=PASS`,
`ANTIGRAVITY_MCP_REGISTRATION_RECONCILIATION=PASS`,
`ANTIGRAVITY_MCP_REGISTRATION_DUPLICATES=NONE`.

**Real `agy` evidence (agy 1.2.0, `/Users/example/.local/bin/agy`, no model turn).**
`agy mcp list` → `No MCP servers configured.` before; `agy mcp add cmm-qoder-tools
<node> <launcher>` → `Added MCP server "cmm-qoder-tools" (stdio)`, list →
`cmm-qoder-tools  stdio  enabled  <node> <launcher>`; `add` is a full
replace (args replaced, `--env` dropped when re-added without it, disabled →
enabled); `remove` → `Removed MCP server "cmm-qoder-tools"`; absent name → exit 1.
The user's prior state (absent) was preserved byte-exact (0-byte
`~/.gemini/config/mcp_config.json`, original mtime, md5
`d41d8cd98f00b204e9800998ecf8427e`); no other registration was touched. A real
two-process probe (maxLive=1, shared dir, 40 attempts each) yielded
`ok=1/refused=0` and `ok=0/refused=40`, descriptorsOnDisk=1.

## 10. P0 #8 — Provider policy is literal, not approximate

**Defect (confirmed).** `claude`/`google` accepted `parallel_tool_calls=false` on
the theory that the Router's single-parked-call limit *is* the provider
constraint. Neither Claude Agent SDK 0.3.266 nor `agy 1.2.0` exposes a
provider-side parallel control.

**Behaviour now.** For `claude` and `google`, ABSENCE of `parallel_tool_calls` is
accepted and ANY explicit boolean (`true` OR `false`) is rejected with
`unsupported_capability` (documented in code). `tool_choice` keeps `auto`/absent
and rejects every other kind. Command Code (exact OpenAI + Anthropic mapping) and
Codex semantics are unchanged. Both HTTP surfaces behave consistently after the
P0 #1 normalization.

**RED observed.** `CLAUDE_/GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION`
→ `expected 200 to be 400` (explicit `false` was accepted).

**GREEN.** `CLAUDE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS`,
`GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION=PASS`,
`SILENT_TOOL_POLICY_APPROXIMATION=NONE`.

## 11. P0 #9/#10 — Multi-step Qoder agent loops + cancellation

Canonical loop proven for every family that claims `CHAT_AND_TOOLS`; the
provider-faithful harness decides tool B only after consuming result A through the
real production transport, and the final text depends on both results.

**chatgpt / Codex.** The one-shot `toolCallFuture` was replaced by a reusable
per-turn pump that re-arms a scoped `item/tool/call` waiter each iteration, keeps
the SAME `threadId` and `turnId`, preserves the declared-tool ACL (retained per
thread), the public/internal id split and the original `item/tool/call`
resolution. `CODEX_TWO_SEQUENTIAL_TOOLS_SAME_THREAD=PASS`,
`CODEX_TWO_SEQUENTIAL_TOOLS_SAME_TURN=PASS`,
`MULTI_STEP_QODER_AGENT_LOOP_CODEX=PASS`,
`CODEX_MULTISTEP_FINAL_DERIVED_FROM_BOTH_RESULTS=PASS`,
`CODEX_MULTISTEP_SECOND_TOOL_ACL_ENFORCED=PASS`.
RED: both the adapter and HTTP loop tests timed out pre-fix.

**claude.** After a parked result is successfully delivered the gate is reopened
(`gate.parked = false`) and the completed park TTL timer retired; truly parallel
unresolved calls are still refused. `CLAUDE_TOOL_A_RESULT_THEN_TOOL_B=PASS`,
`CLAUDE_TWO_SEQUENTIAL_TOOLS_SAME_LOGICAL_RUN=PASS`,
`MULTI_STEP_QODER_AGENT_LOOP_CLAUDE=PASS`,
`CLAUDE_PARALLEL_UNRESOLVED_CALL_REFUSED=PASS`.
RED: exchange 2 produced no tool B, only `provider_protocol_error`.

**google / Antigravity.** Same gate reopening; the parked session now retains its
request binding so cancellation can reach the live run (both the `runToolSession`
and continuation `finally` paths). `ANTIGRAVITY_TOOL_A_RESULT_THEN_TOOL_B=PASS`,
`ANTIGRAVITY_TWO_SEQUENTIAL_TOOLS_SAME_AGY_RUN=PASS` (exactly one agy process for
both tools), `MULTI_STEP_QODER_AGENT_LOOP_GOOGLE=PASS`,
`MULTI_STEP_QODER_AGENT_LOOP_GOOGLE_HTTP=PASS`.
RED: the second tool call was never parked.

**command-code.** Both wires already supported the loop; no production defect
existed (proven by mutation testing: dropping `assistant.tool_calls` or mangling
the `tool_use` id produced RED). Regression guard added:
`COMMAND_CODE_OPENAI_TWO_STEP_TOOL_LOOP=PASS`,
`COMMAND_CODE_ANTHROPIC_TWO_STEP_TOOL_LOOP=PASS`,
`HTTP_MULTISTEP_OPENAI_WIRE=PASS`, `HTTP_MULTISTEP_ANTHROPIC_WIRE=PASS`,
`HTTP_MULTISTEP_{OPENAI,ANTHROPIC}_TOOL_IDS_PRESERVED=PASS`.

**Global.** `MULTI_STEP_QODER_AGENT_LOOP=PASS`.

**Cancellation (P0 #10).** Lifecycle edges covered: before tool A, waiting result
A, between result A and tool B, waiting result B, after result B before final.
After each cancellation: no provider run, no broker entry, no bridge pending, no
control socket, no rendezvous descriptor, no claimable stale public tool id, and
unrelated concurrent sessions survive.
`MULTI_STEP_CANCEL_BETWEEN_TOOLS=PASS`, `MULTI_STEP_CANCEL_WAITING_TOOL_A=PASS`,
`MULTI_STEP_CANCEL_WAITING_TOOL_B=PASS`, `MULTI_STEP_CANCEL_PRE_TOOL=PASS`,
`MULTI_STEP_CANCEL_AFTER_TOOL_B_RESULT=PASS`, `MULTI_STEP_FINAL_CLEANUP=PASS`.

## 12. Adversarial self-review (goal §"ADVERSARIAL FINAL REVIEW")

Greps for unbounded Map/Array/string append, one-shot tool waiter, gate never
reset, stale session file, child without kill escalation, `tools/call` without
strict id, silent `catch/continue`, silent event drop, ignored
`tool_choice`/`parallel_tool_calls`, undeclared tool, second sequential tool
failure, new thread/run on continuation, native provider edit capability, PAYG env
access, secret logging. Findings and dispositions:

- Antigravity NDJSON/line/stdout/stderr accumulators → bounded (§8).
- `claude/mcp-bridge.ts` stdin line buffer → bounded (§8).
- Command Code SSE residual → bounded; swallowed body errors now surfaced (§8).
- `src/bridge/control-ipc.ts:321` `catch { continue; }` — the Router→bridge
  *client* response parser. Direction is Router→bridge (inside the trust
  boundary), the retained buffer is bounded by `MAX_CONTROL_FRAME_BYTES`, and a
  lost frame fails the parked request at TTL/socket close. Documented as a
  deliberate, bounded policy; not provider-controlled input.
- `didOverflow()` now has production consumers in the audit path.
- Aggregate response `content +=` in the HTTP layers is downstream of the bounded
  provider paths and `max_tokens`; unchanged.

## 13. Security invariants

```text
PROVIDER_OWNS_REASONING=YES
QODER_OWNS_TOOLS=YES / FILESYSTEM=YES / SHELL=YES / EDITS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
API_PAYG_FALLBACK=NONE / CROSS_PROVIDER_FALLBACK=NONE / UNKNOWN_MODEL_FALLBACK=NONE
OAUTH_EXTRACTION=NO / OAUTH_COPY=NO / OAUTH_SYNC=NO
COMMAND_CODE_ON_DEMAND=NO / COMMAND_CODE_AUTO_TOP_UP=NO
PROMPT_LOGGING=NO / COMPLETION_LOGGING=NO
TOOL_ARGUMENT_LOGGING=NONE / TOOL_RESULT_LOGGING=NONE
LOOPBACK_ONLY=YES
NO_TRACKED_SECRETS=PASS
```

`bash scripts/security-audit.sh` → `SECURITY_AUDIT=PASS` (supplementary; the
runtime/adversarial suites above are the primary evidence).

## 14. Regression gate (executed)

```text
TEST_RUN_1      = PASS   Test Files 119 passed | 5 skipped (124)
                         Tests 615 passed | 25 skipped (640)
TEST_RUN_2      = PASS   Test Files 119 passed | 5 skipped (124)
TEST_RUN_3      = PASS   Test Files 119 passed | 5 skipped (124)
TYPECHECK       = PASS   (tsc -p tsconfig.json --noEmit, rc=0)
BUILD           = PASS   (tsc -p tsconfig.build.json, rc=0)
POST_BUILD_TEST = PASS   Test Files 119 passed | 5 skipped (124)
SECURITY_AUDIT  = PASS
```

The 5 skipped files / 25 skipped tests are the pre-existing `CMM_RUN_LIVE`
live-provider and mutation gates; they are not executed in this deterministic
pass. Every NEW deterministic suite was executed explicitly by path
(16 files, 92 tests, all passed) and its markers captured.

TEST_FILES=124 · TESTS=615 · SKIPPED=25.

## 15. Remaining live-only uncertainty

- Claude: the real Agent SDK MCP invocation under a subscription remains a live
  canary. The deterministic path is proven against the real production MCP stdio
  child and the protocol-faithful fake SDK.
- Antigravity: the real `agy` MCP invocation remains a live canary. The real
  launcher, control socket, registry descriptor and process termination are proven
  deterministically.
- Codex: the real app-server model turn remains live; the protocol loop is proven
  against the scripted app-server.
- `agy mcp list` never prints env, so "no env" is enforced by re-issuing `add`
  (verified to clear env) rather than by reading it back. Duplicate rows cannot
  occur in the real name-keyed store; duplicate reconciliation is proven against
  an injected multi-row store plus post-write verification.
- The registry lock coordinates only Routers sharing `CMM_BRIDGE_REGISTRY_DIR`.
- `tests/providers/claude-adapter.test.ts` live-SDK cases were widened to a 45 s
  budget (measured 11–13 s isolated, exceeded 15 s under full-suite worker load).
  No assertion was relaxed.

## 16. Live canary scripts (PREPARED, NOT EXECUTED)

```text
scripts/live-canary/canary-lib.sh
scripts/live-canary/canary-claude.sh
scripts/live-canary/canary-antigravity.sh
scripts/live-canary/canary-codex.sh
scripts/live-canary/canary-command-code.sh
```

All are syntax-checked and fail closed without
`CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend`. They poison PAYG
env vars, verify the subscription route from `/v1/models` (fail closed on
ambiguity), issue exactly one minimal non-streaming request with one harmless
synthetic tool (`canary_echo`, no I/O), perform no filesystem/repo mutation, and
never print the bearer token. **Not executed in this pass.**

`LIVE_PROVIDER_INFERENCE_RUN=NO`.

## 17. Verdict

```text
CMM_SUBSCRIPTION_ROUTER_TASK13_FINAL_PROTOCOL_EDGE_HARDENING=PASS
STATUS=IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
NEXT=INDEPENDENT_TASK13_FINAL_PROTOCOL_EDGE_REAUDIT
```

Every required deterministic marker is PASS, the full regression gate is green,
and no item is skipped. Independent re-audit remains pending; no live provider
canary should run until it passes.
