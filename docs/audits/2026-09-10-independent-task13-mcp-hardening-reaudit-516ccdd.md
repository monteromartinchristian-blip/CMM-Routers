# CMM Subscription Router — Independent Task 13 MCP Hardening Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `516ccdd0efd9d5f7d89a7b0db8075e684e1b7062`
**Scope:** Task 13 — MCP Hardening & Provider Policy
**Verdict:** **FAIL**
**Live provider canaries authorized:** **NO**

## 0. Independent artifact integrity

The uploaded exact Git archive was independently verified before source inspection:

```text
AUDITED_HEAD=516ccdd0efd9d5f7d89a7b0db8075e684e1b7062
ARCHIVE_COMMIT=516ccdd0efd9d5f7d89a7b0db8075e684e1b7062
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=4028dfae765085947196ef59c6d884c8cf9b93086ae4459a711ba4786b5b83b8
LOG_SHA256=7cb49ea074351b0f106af45036d9b43261016048172e3431c166c6848a97d20f
GZIP_TEST=PASS
ARCHIVE_ENTRIES=558
EXTRACTED_FILES=518
```

The supplied Mac verification capture reports:

```text
TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
TARGETED_MCP_HARDENING_RC=0
LIVE_TOOL_ACCEPTANCE_RUN=NO

FULL_SUITE:
103 test files passed
5 test files skipped
520 tests passed
25 tests skipped
```

The skipped suites are the existing `CMM_RUN_LIVE` provider/mutation integration gates. This is a strong regression signal. It does not by itself prove each new protocol/lifecycle claim.

Captured runtime versions:

```text
node=v26.5.0
npm=11.17.0
codex-cli=0.153.4
agy=1.2.0
@anthropic-ai/claude-agent-sdk=0.3.266
```

---

# 1. Executive result

This hardening pass fixes several defects from the previous independent audit for real.

The following improvements are supported by direct source inspection plus the supplied deterministic test capture:

```text
CLAUDE_DUPLICATE_PROVIDER_FACING_MCP_PROCESS=FIXED
CLAUDE_PROTOCOL_FAITHFUL_FAKE_SDK_E2E=PASS_DETERMINISTIC
CLAUDE_FAKE_RELEASE_ESCAPE_HATCH=REMOVED

ANTIGRAVITY_GLOBAL_SINGLE_SESSION_DISCOVERY=REMOVED
ANTIGRAVITY_TWO_CONCURRENT_SESSIONS=PASS_DETERMINISTIC
ANTIGRAVITY_RUNTIME_REVALIDATED=1.2.0

BRIDGE_CONTROL_PENDING_BOUND=PASS
PROVIDER_TOOL_QUEUE_BOUND=PASS
DECLARED_TOOL_ACL_CORE_PATHS=PASS

COMMAND_CODE_OPENAI_POLICY_FORWARDING=PRESERVED
COMMAND_CODE_ANTHROPIC_CORE_TOOL_WIRE=PRESERVED

CODEX_DYNAMIC_TOOLS_AND_SAME_TURN_CONTINUATION=PRESERVED
RESPONSES_FUNCTION_CALL_OUTPUT_LIFECYCLE=PRESERVED
```

However, the requested deterministic hardening pass is **not yet complete**. Independent source inspection finds multiple concrete gaps that are not covered by the final PASS markers:

```text
RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=FAIL
ANTIGRAVITY_STREAM_EVENT_OVERFLOW_FAIL_CLOSED=FAIL
ANTIGRAVITY_ABORT_SIGKILL_ESCALATION=FAIL
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=FAIL
MCP_TOOL_CALL_JSONRPC_ID_FAIL_CLOSED=FAIL

SESSION_REGISTRY_BOUND_ACROSS_RESTART=PARTIAL
CLAUDE_GOOGLE_EXPLICIT_PARALLEL_FALSE_SEMANTICS=PARTIAL_OVERCLAIM

MULTI_STEP_TOOL_LOOP_CODEX=NOT_SUPPORTED
MULTI_STEP_TOOL_LOOP_CLAUDE=NOT_SUPPORTED
MULTI_STEP_TOOL_LOOP_GOOGLE=NOT_SUPPORTED
```

The first five are sufficient to keep this pass at **FAIL** and to withhold live-provider acceptance.

---

# 2. Claude — the previous false-positive E2E is materially fixed

## 2.1 One authoritative provider-facing MCP owner

The previous implementation spawned a Router-owned MCP process and separately passed an MCP config to the SDK. That duplication is gone.

Current production design:

```text
ClaudeAdapter
    |
    +-- Router-side BridgeControlServer
    |
    +-- options.mcpServers.cmm_qoder
            |
            +-- provider-facing stdio MCP child owned by Claude SDK
```

The adapter itself no longer contains the old provider-facing `spawn()` seam.

The production `mcpServers` object carries the exact bridge command, entry point, socket/token/tool environment and declared tool set.

### Verdict

```text
CLAUDE_PROVIDER_FACING_MCP_OWNER=claude-agent-sdk
CLAUDE_DUPLICATE_MCP_BRIDGE_PROCESS=NONE
```

## 2.2 Deterministic causality proof is now substantially stronger

`tests/helpers/fake-claude-sdk.ts` now behaves as an MCP client rather than merely waiting on an unrelated Promise. It consumes the production SDK options, launches the configured MCP stdio child, performs MCP setup/list/call, waits for the MCP tool result, and derives its final provider text from that result.

The new test capture records:

```text
CLAUDE_FAKE_SDK_CONSUMED_PRODUCTION_MCP_CONFIG=PASS
CLAUDE_FAKE_SDK_SPAWNED_CONFIGURED_MCP=PASS
CLAUDE_FAKE_SDK_SENT_TOOLS_CALL=PASS
CLAUDE_MCP_RESULT_CAUSED_PROVIDER_CONTINUATION=PASS
CLAUDE_SAME_LOGICAL_RUN=PASS
```

The old `fake.release()` causal escape hatch is no longer the basis of the E2E.

### Verdict

```text
CLAUDE_CAUSAL_FAKE_SDK_E2E=PASS_DETERMINISTIC
CLAUDE_ACTUAL_SUBSCRIPTION_SDK_MCP_INVOCATION=LIVE_PROOF_STILL_REQUIRED
```

That distinction matters: deterministic architecture is now credible, but the real Claude SDK behavior remains a legitimate live-canary item.

---

# 3. Antigravity concurrency — previous structural defect is fixed deterministically

The old launcher searched a global registry and only succeeded when exactly one session existed. That architecture broke two simultaneous Google tool runs.

The current implementation uses a per-provider-process descriptor:

```text
<registry>/agy-<pid>.json
```

and resolves only the launcher's own bounded ancestor PID chain. There is no directory-wide "find the only live session" selection path.

`tests/providers/antigravity-concurrency.test.ts` exercises two overlapping fake agy runs, each spawning the production launcher, and the supplied capture records the suite as passing.

### Verdict

```text
ANTIGRAVITY_GLOBAL_SINGLE_SESSION_SCAN=REMOVED
ANTIGRAVITY_TWO_CONCURRENT_TOOL_SESSIONS=PASS_DETERMINISTIC
ANTIGRAVITY_CROSS_RUN_RESULT_ISOLATION=PASS_DETERMINISTIC
ANTIGRAVITY_REAL_AGY_MCP_INVOCATION=LIVE_PROOF_STILL_REQUIRED
```

---

# 4. Declared-tool ACL — the audited boundaries are now present

The current MCP process builds an immutable name set from `CMM_BRIDGE_TOOLS` and rejects an undeclared `tools/call` before forwarding it into the Router control channel.

Codex validates `item/tool/call.params.tool` against the tool names declared on that exact dynamic-tool thread.

Command Code validates returned OpenAI tool call names and Anthropic `tool_use.name` against the request's declared tool set.

### Verdict

```text
MCP_UNDECLARED_TOOL_CALL_FAIL_CLOSED=PASS_STATIC_DETERMINISTIC
CODEX_UNDECLARED_DYNAMIC_TOOL_FAIL_CLOSED=PASS_STATIC_DETERMINISTIC
COMMAND_CODE_OPENAI_UNDECLARED_TOOL_FAIL_CLOSED=PASS_STATIC_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_UNDECLARED_TOOL_FAIL_CLOSED=PASS_STATIC_DETERMINISTIC
DECLARED_TOOL_ACL_CORE_BOUNDARIES=PASS
```

This fixes a real provider→Qoder authorization gap from `cab1060`.

---

# 5. Bounded pending state — core containers improved, but the global claim is still too broad

The following now have explicit bounds:

```text
DeferredToolBroker.entries                 64
BridgeControlServer.pending                16
Claude tool request queue                   1
Antigravity tool request queue              1
Claude live tool sessions                  64
Antigravity live tool sessions             64
Antigravity StreamEventQueue             4096
BridgeSessionRegistry in-memory live       64
```

`BridgeControlServer.pending` also has a finite TTL.

That closes the previous unbounded `pending` Map / async tool-queue problem.

### Narrow verdict

```text
BROKER_PENDING_BOUND=PASS
BRIDGE_CONTROL_PENDING_BOUND=PASS
CLAUDE_TOOL_QUEUE_BOUND=PASS
ANTIGRAVITY_TOOL_QUEUE_BOUND=PASS
LIVE_PROVIDER_TOOL_SESSION_BOUND_IN_PROCESS=PASS
```

But two lower-level buffers remain unbounded; one is provider-facing and one is the agy subprocess output accumulator. See §§8 and 9.

---

# 6. P0/P1 — Responses canonical named-function `tool_choice` is parsed with the Chat Completions shape

## 6.1 Source defect

`src/core/tool-policy.ts:26-50` normalizes a named function only in this form:

```json
{
  "type": "function",
  "function": {
    "name": "t"
  }
}
```

That is the **Chat Completions** named-tool-choice shape.

`src/http/openai-responses.ts:183-192` takes `body.tool_choice` raw and passes it into the same normalizer through the shared provider policy.

But the current OpenAI Responses API's forced function tool choice is a flat object:

```json
{
  "type": "function",
  "name": "t"
}
```

The current OpenAI API reference defines Responses `ToolChoiceFunction` with `{name, type}`, while Chat Completions' `ChatCompletionNamedToolChoice` uses `{type, function:{name}}`.

Therefore a valid Responses request such as:

```json
{
  "model": "command-code/...",
  "tools": [
    {
      "type": "function",
      "name": "t",
      "parameters": {}
    }
  ],
  "tool_choice": {
    "type": "function",
    "name": "t"
  }
}
```

reaches `normalizeToolChoice()`, finds no nested `.function.name`, and returns `invalid_request`.

## 6.2 Why the existing PASS test misses it

`tests/providers/tool-policy-matrix.test.ts:125-141` compares Chat and Responses status codes using the **same input object** for both surfaces.

It exercises string forms such as `required` and `auto`, but does not send the canonical Responses flat named-function object.

So:

```text
CHAT_RESPONSES_TOOL_POLICY_CONSISTENCY=PASS
```

only proves consistency for the tested shared subset. It does not prove wire-correct normalization for each API.

### Verdict

```text
RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=FAIL
CHAT_RESPONSES_TOOL_POLICY_WIRE_NORMALIZATION=FAIL
TOOL_POLICY_GLOBAL_PASS=NO
```

### Required remediation

Normalize at the API boundary:

```text
Chat Completions:
{type:"function", function:{name}}

Responses:
{type:"function", name}
```

into one internal representation:

```text
{kind:"named", name}
```

Then apply provider policy to the internal representation.

Add a regression test that sends the exact canonical wire shape to each endpoint rather than reusing one wire object for both.

---

# 7. P0 — Antigravity StreamEventQueue overflow is silently dropped

## 7.1 Source defect

`src/providers/antigravity/adapter.ts:347-384` implements:

```ts
if (this.events.length >= this.maxSize) {
  this.overflowed = true;
  return;
}
```

and exposes:

```ts
didOverflow(): boolean
```

However repository-wide source inspection finds **no consumer of `didOverflow()`** outside its definition.

The queue therefore becomes memory-bounded, but when it fills it silently discards the provider event.

This directly contradicts the hardening design:

```text
StreamEventQueue max MAX_STREAM_EVENTS
→ protocol error + terminal
```

and the evidence claim that overflow is a terminal condition.

A dropped event may be text, usage, protocol-error, or terminal/completion state. Memory safety is not equivalent to fail-closed protocol behavior.

### Verdict

```text
ANTIGRAVITY_STREAM_EVENT_QUEUE_BOUNDED=PASS
ANTIGRAVITY_STREAM_EVENT_OVERFLOW_FAIL_CLOSED=FAIL
ANTIGRAVITY_STREAM_EVENT_OVERFLOW_SILENT_DROP=YES
```

### Required remediation

`push()` should return a success/failure outcome or enqueue one terminal overflow error exactly once. The provider run must be aborted and the adapter must emit `provider_protocol_error` rather than simply setting an unread flag.

Add a deterministic small-capacity queue test that drives the **adapter production path**, forces overflow, and proves:

```text
provider aborted
protocol error emitted
no completion emitted after overflow
queue/session state cleaned
```

---

# 8. P0 — Antigravity session abort does not implement the claimed SIGKILL escalation

## 8.1 Source mismatch

`src/providers/antigravity/adapter.ts:516-530` has the timeout path:

```text
SIGINT
wait 2 s
SIGKILL
```

But the ordinary AbortSignal path at `:531-538` does only:

```ts
child.kill("SIGINT");
```

There is no 2-second SIGKILL escalation attached to the abort path.

Meanwhile `closeToolSession()` says:

```text
abort the live agy process (SIGINT with SIGKILL escalation)
```

and the evidence document reports provider termination semantics as though the same escalation applied to TTL/cancellation.

That is not what production does.

## 8.2 Why current lifecycle tests do not prove it

The deterministic fake/lifecycle harnesses kill their child processes directly, often with `SIGKILL`. They prove that the adapter calls the retained AbortController and cleans Router state. They do not prove that the real `SpawnInferenceRunner` guarantees process exit after an AbortSignal.

A real `agy` process that ignores or stalls on SIGINT can therefore remain alive after session cleanup until another mechanism terminates it.

### Verdict

```text
ANTIGRAVITY_ABORT_SIGNAL_SENDS_SIGINT=PASS
ANTIGRAVITY_ABORT_SIGKILL_ESCALATION=FAIL

ANTIGRAVITY_TTL_ABORTS_PROVIDER_CONTROLLER=PASS
ANTIGRAVITY_TTL_GUARANTEES_PROVIDER_PROCESS_EXIT=NO

ANTIGRAVITY_POST_RESULT_CANCEL_ABORTS_PROVIDER_CONTROLLER=PASS
ANTIGRAVITY_POST_RESULT_CANCEL_GUARANTEES_PROVIDER_PROCESS_EXIT=NO

PRODUCTION_CANCEL_POST_RESULT=PARTIAL_AT_REAL_PROCESS_BOUNDARY
```

### Required remediation

Factor child termination into one path used by both timeout and AbortSignal:

```text
SIGINT
→ bounded grace period
→ if child still live, SIGKILL
→ settle only after close/error or explicit bounded termination verdict
```

Test with a real local fixture child that deliberately traps/ignores SIGINT.

No model inference is needed.

---

# 9. P1/security — provider-facing MCP stdio input buffer is unbounded

`src/bridge/mcp-bridge-process.ts:75-80` performs:

```ts
let buffer = "";

stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
});
```

There is no maximum line/frame/buffer length.

The Router-side control socket correctly applies a one-MiB frame bound, but this earlier provider-facing MCP parser does not.

A provider process can therefore send an arbitrarily large unterminated JSON line and cause this bridge child to keep growing `buffer` before any `BridgeControlServer` or broker bound is reached.

### Verdict

```text
MCP_CONTROL_SOCKET_FRAME_BOUND=PASS
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=FAIL
PROVIDER_CONTROLLED_BRIDGE_BUFFER_BOUNDED=NO
```

### Required remediation

Add a finite MCP input-frame bound before or while appending data. On overflow:

```text
do not forward a tool call
emit protocol error where possible
terminate bridge/session fail closed
clear buffer/state
```

Use a bound compatible with the Router's existing request/body/tool limits.

---

# 10. P1/protocol — MCP `tools/call` can reach Qoder without a JSON-RPC request id

`src/bridge/mcp-bridge-process.ts` defines:

```ts
interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: ...
}
```

For `method === "tools/call"` it never requires `message.id`.

The code can therefore:

```text
receive tools/call with id=undefined
→ validate declared tool name
→ create an internal callId
→ BridgeControlClient.request(...)
→ surface an executable tool call to Qoder
```

and later attempt to write a JSON-RPC response whose `id` is undefined/omitted.

`tools/call` is a request/response operation. A malformed notification-like frame must not become a Qoder-executable action.

### Verdict

```text
MCP_TOOL_CALL_JSONRPC_REQUEST_ID_REQUIRED=FAIL
MALFORMED_MCP_TOOL_CALL_CAN_REACH_QODER=YES
```

### Required remediation

Before any control-channel call:

```text
jsonrpc === "2.0"
id is string|number
method === "tools/call"
params is valid
declared tool ACL passes
```

Otherwise fail closed and do not create Router/broker/tool state.

Also replace the current malformed-JSON `catch { continue; }` behavior with a deliberate protocol-error/termination policy for provider-facing malformed frames.

---

# 11. P1 — Antigravity subprocess output accumulation remains unbounded

The new `StreamEventQueue` is bounded, but `SpawnInferenceRunner` still accumulates:

```ts
stdout += text;
lineBuffer += text;
stderr += chunk.toString("utf-8");
```

for the lifetime of the agy process, with no byte maximum.

Therefore:

```text
STREAM_EVENT_QUEUE_BOUNDED=YES
AGY_STDOUT_ACCUMULATOR_BOUNDED=NO
AGY_STDERR_ACCUMULATOR_BOUNDED=NO
AGY_PARTIAL_LINE_BUFFER_BOUNDED=NO
```

The hardening claim `GLOBAL_TOOL_PENDING_STATE_BOUNDED=PASS` is true for the named pending-tool containers, but should not be generalized into a global provider-controlled-memory bound.

### Required remediation

Use capped diagnostic buffers and a bounded NDJSON line buffer. Preserve enough stderr/stdout for safe error mapping without retaining arbitrary provider output in memory.

An oversized NDJSON line should become a protocol error, not indefinite accumulation.

---

# 12. P1 — session-registry max=64 is process-local, not a global/restart bound

`src/bridge/session-registry.ts:183-223` checks:

```ts
private readonly live = new Map<number, string>();

if (this.live.size >= this.maxLive) {
   ...
}
```

and then writes `<registry>/agy-<pid>.json`.

The capacity check does **not** reconcile the descriptors already present on disk. `descriptorsOnDisk()` is a diagnostic only.

After a Router crash/restart, the in-memory Map starts at zero even if stale descriptors remain. Two Router processes can also each independently believe they are below 64.

### Verdict

```text
SESSION_REGISTRY_MAX_LIVE_IN_PROCESS=64
SESSION_REGISTRY_OVERFLOW_IN_PROCESS_FAIL_CLOSED=PASS

SESSION_REGISTRY_BOUND_ACROSS_RESTART=NOT_PROVEN
SESSION_REGISTRY_BOUND_ACROSS_MULTIPLE_ROUTER_PROCESSES=NOT_PROVEN
```

This is not the primary Task 13 blocker, but it should be fixed together with the already-admitted Antigravity restart reconciliation work before production acceptance.

---

# 13. Provider-policy semantic overclaim: explicit `parallel_tool_calls=false` for Claude/Google

`src/core/tool-policy.ts` accepts:

```text
Claude: parallel_tool_calls=false
Google: parallel_tool_calls=false
```

because the Router itself allows only one parked MCP call per session.

However, neither Claude Agent SDK 0.3.266 nor `agy 1.2.0` has an identified provider-side parallel-tool control in the audited surface.

The requirement for this pass was:

```text
faithfully map
OR
explicitly reject
NEVER silently ignore
```

Router-side refusal of a second emitted call is a safety limit. It is not necessarily equivalent to telling the provider that parallel calls are disabled.

### Conservative verdict

```text
CLAUDE_PARALLEL_TOOL_CALLS_TRUE=REJECTED
GOOGLE_PARALLEL_TOOL_CALLS_TRUE=REJECTED

CLAUDE_EXPLICIT_PARALLEL_FALSE_PROVIDER_SEMANTICS=PARTIAL
GOOGLE_EXPLICIT_PARALLEL_FALSE_PROVIDER_SEMANTICS=PARTIAL
```

### Recommended remediation

Until a provider-native representation is proven, accept **absence** of the field but reject any explicit `parallel_tool_calls` value for Claude/Google.

That avoids claiming a caller constraint was enforced upstream when the Router only enforces its own single-call handoff limit.

---

# 14. Functional limitation discovered: repeated tool loops are not yet supported by three providers

This is not required to overturn the current pass — the original Task 13 acceptance text explicitly demands a tool-call round-trip, singular — but it matters for Qoder's practical agent mode and should not be hidden.

## 14.1 Claude

After the first successful park:

```ts
session.gate.parked = true;
```

On successful Qoder result handling the code clears `publicToolCallId` and `parkedRequestId`, but does not reset `gate.parked`.

A second sequential `tools/call` from the same still-running Claude session therefore hits:

```text
Concurrent Claude MCP tool calls are not supported
```

even if the first call already completed.

## 14.2 Antigravity

The same pattern exists:

```ts
session.gate.parked = true;
```

and it is not reset after a successful result before the provider continues.

A second sequential MCP call in that run is rejected.

## 14.3 Codex

The initial run creates one one-shot `toolCallFuture`.

After Qoder resolves that tool call, `drainTurn()` listens only for:

```text
item/agentMessage/delta
thread/tokenUsage/updated
turn/completed
```

It does not install another `item/tool/call` waiter.

Therefore a second dynamic tool request during the same Codex turn cannot complete through the same external Qoder loop.

### Verdict / limitation

```text
SINGLE_TOOL_ROUNDTRIP_CODEX=SUPPORTED_DETERMINISTIC
SINGLE_TOOL_ROUNDTRIP_CLAUDE=SUPPORTED_DETERMINISTIC
SINGLE_TOOL_ROUNDTRIP_GOOGLE=SUPPORTED_DETERMINISTIC

MULTI_STEP_TOOL_LOOP_CODEX=FAIL
MULTI_STEP_TOOL_LOOP_CLAUDE=FAIL
MULTI_STEP_TOOL_LOOP_GOOGLE=FAIL
```

### Recommendation

Do not necessarily enlarge the immediate remediation if Task 13 is intentionally scoped to the original one-call acceptance criterion.

But before advertising the Router as a full replacement for ordinary Qoder agent mode, add a later acceptance:

```text
tool A
→ Qoder result A
→ same provider requests tool B
→ Qoder result B
→ final answer
```

for every provider family that claims general agentic tool use.

---

# 15. Antigravity MCP registration after Router restart remains open

The evidence itself correctly admits this.

Current production still uses:

```ts
if (this.mcpRegistered) return;
this.mcpRegistrar(... agy mcp add ...);
this.mcpRegistered = true;
```

so idempotence is only remembered in one adapter process.

The captured `agy 1.2.0` help describes `mcp add` as **"Add or update an MCP server configuration"**, which is encouraging, but the actual existing-registration/restart behavior was not captured in this pass.

### Verdict

```text
ANTIGRAVITY_MCP_REGISTRATION_SINGLE_PROCESS=PASS
ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=NOT_PROVEN
```

This can be verified without a model turn and should be done before the live Google canary.

---

# 16. What should remain closed / preserved

Independent inspection does not justify reopening the following work:

```text
CMMCHAT_CHAT_ONLY_BOUNDARY=PASS_BASELINE
QODER_AUTH_BOUNDARY=PASS_BASELINE
PAYG_FAIL_CLOSED_BASELINE=PASS
LOOPBACK_BASELINE=PASS
NO_PROVIDER_NATIVE_EDIT_PATH=PASS_STATIC

CODEX_EXPERIMENTAL_DYNAMIC_TOOLS=PRESERVE
CODEX_DECLARED_TOOL_ACL=PRESERVE
CODEX_SAME_THREAD_TURN_CONTINUATION=PRESERVE
CODEX_PUBLIC_INTERNAL_CALL_ID_SPLIT=PRESERVE

DEFERRED_TOOL_BROKER_PRODUCTION_COMPOSITION=PRESERVE
DEFERRED_TOOL_BROKER_BOUND_TTL=PRESERVE

CLAUDE_SINGLE_SDK_OWNED_MCP_CHILD=PRESERVE
CLAUDE_CAUSAL_FAKE_SDK_TEST=PRESERVE

ANTIGRAVITY_ANCESTOR_PID_CONCURRENCY=PRESERVE

COMMAND_CODE_OPENAI_CORE_TOOL_WIRE=PRESERVE
COMMAND_CODE_ANTHROPIC_CORE_TOOL_WIRE=PRESERVE

RESPONSES_FUNCTION_CALL_ID_ITEM_LIFECYCLE=PRESERVE
TOOL_RESULT_1MIB_BOUND=PRESERVE
QODER_BEARER_PROVISIONING=PRESERVE
```

The next pass should be small and surgical.

---

# 17. Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_MCP_HARDENING_REAUDIT=FAIL

AUDITED_HEAD=516ccdd0efd9d5f7d89a7b0db8075e684e1b7062
ARCHIVE_COMMIT=516ccdd0efd9d5f7d89a7b0db8075e684e1b7062
ARCHIVE_COMMIT_MATCH=YES

BUNDLE_SHA256=4028dfae765085947196ef59c6d884c8cf9b93086ae4459a711ba4786b5b83b8
LOG_SHA256=7cb49ea074351b0f106af45036d9b43261016048172e3431c166c6848a97d20f
GZIP_TEST=PASS

REGRESSION_SIGNAL=STRONG
MACHINE_TEST_GATE=PASS_REPORTED
LIVE_TOOL_ACCEPTANCE_RUN=NO

CLAUDE_DUPLICATE_PROVIDER_FACING_MCP_PROCESS=NONE
CLAUDE_CAUSAL_FAKE_SDK_E2E=PASS_DETERMINISTIC
CLAUDE_ACTUAL_SDK_MCP_INVOCATION=LIVE_PROOF_REQUIRED

ANTIGRAVITY_RUNTIME_VERSION=1.2.0
ANTIGRAVITY_TWO_CONCURRENT_TOOL_SESSIONS=PASS_DETERMINISTIC
ANTIGRAVITY_CROSS_RUN_RESULT_ISOLATION=PASS_DETERMINISTIC
ANTIGRAVITY_REAL_AGY_MCP_INVOCATION=LIVE_PROOF_REQUIRED

BROKER_PENDING_BOUND=PASS
BRIDGE_CONTROL_PENDING_BOUND=PASS
PROVIDER_TOOL_QUEUE_BOUND=PASS
DECLARED_TOOL_ACL_CORE_BOUNDARIES=PASS

RESPONSES_FUNCTION_CALL_OUTPUT_LIFECYCLE=PASS_DETERMINISTIC
RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=FAIL
CHAT_RESPONSES_TOOL_POLICY_WIRE_NORMALIZATION=FAIL

ANTIGRAVITY_STREAM_EVENT_QUEUE_BOUNDED=PASS
ANTIGRAVITY_STREAM_EVENT_OVERFLOW_FAIL_CLOSED=FAIL
ANTIGRAVITY_STREAM_EVENT_OVERFLOW_SILENT_DROP=YES

ANTIGRAVITY_ABORT_SIGNAL_SENDS_SIGINT=PASS
ANTIGRAVITY_ABORT_SIGKILL_ESCALATION=FAIL
ANTIGRAVITY_TTL_GUARANTEES_PROVIDER_PROCESS_EXIT=NO
ANTIGRAVITY_POST_RESULT_CANCEL_GUARANTEES_PROVIDER_PROCESS_EXIT=NO

MCP_CONTROL_SOCKET_FRAME_BOUND=PASS
MCP_PROVIDER_FACING_STDIO_FRAME_BOUND=FAIL
MCP_TOOL_CALL_JSONRPC_REQUEST_ID_REQUIRED=FAIL

AGY_STDOUT_ACCUMULATOR_BOUNDED=NO
AGY_STDERR_ACCUMULATOR_BOUNDED=NO
AGY_NDJSON_PARTIAL_LINE_BOUND=NO

SESSION_REGISTRY_MAX_LIVE_IN_PROCESS=64
SESSION_REGISTRY_BOUND_ACROSS_RESTART=NOT_PROVEN
ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=NOT_PROVEN

CLAUDE_EXPLICIT_PARALLEL_FALSE_PROVIDER_SEMANTICS=PARTIAL
GOOGLE_EXPLICIT_PARALLEL_FALSE_PROVIDER_SEMANTICS=PARTIAL

SINGLE_TOOL_ROUNDTRIP_CODEX=SUPPORTED_DETERMINISTIC
SINGLE_TOOL_ROUNDTRIP_CLAUDE=SUPPORTED_DETERMINISTIC
SINGLE_TOOL_ROUNDTRIP_GOOGLE=SUPPORTED_DETERMINISTIC

MULTI_STEP_TOOL_LOOP_CODEX=NOT_SUPPORTED
MULTI_STEP_TOOL_LOOP_CLAUDE=NOT_SUPPORTED
MULTI_STEP_TOOL_LOOP_GOOGLE=NOT_SUPPORTED

QODER_EXECUTION_OWNER=YES_DESIGN_AND_DETERMINISTIC_PATH
PROVIDER_NATIVE_TOOL_EXECUTION=NONE_STATIC_AND_DETERMINISTIC_PATH

API_PAYG_FALLBACK=NONE_BASELINE
CROSS_PROVIDER_FALLBACK=NONE_BASELINE
UNKNOWN_MODEL_FALLBACK=NONE_BASELINE
COMMAND_CODE_ON_DEMAND=NONE_BASELINE

LIVE_PROVIDER_CANARIES_AUTHORIZED=NO
FINAL_TASK13_CLOSURE_ELIGIBLE=NO

NEXT=TASK13_FINAL_PROTOCOL_EDGE_HARDENING
```

---

# 18. Required next pass — Task 13 Final Protocol Edge Hardening

Do **not** reopen the major architecture. Implement only the remaining edge defects:

### A. API-specific tool-choice normalization

Parse Chat and Responses named-function forms at their respective HTTP boundaries and normalize them internally.

Add exact wire tests for:

```text
Chat:
{"type":"function","function":{"name":"t"}}

Responses:
{"type":"function","name":"t"}
```

### B. Antigravity stream overflow must be terminal

Make `StreamEventQueue` overflow immediately observable by the adapter.

Abort the provider and return `provider_protocol_error`.

No silent dropped event.

### C. Real agy AbortSignal escalation

Use one shared child-termination helper:

```text
SIGINT → grace → SIGKILL
```

for timeout and ordinary abort.

Test against a local process that deliberately ignores SIGINT.

### D. Bound raw process/protocol buffers

Bound:

```text
mcp-bridge-process stdin line buffer
agy NDJSON partial-line buffer
agy stdout diagnostic accumulator
agy stderr diagnostic accumulator
```

Oversize provider data must fail closed.

### E. Validate MCP JSON-RPC identity

For executable `tools/call`, require a valid request id and `jsonrpc:"2.0"` before any control-channel/broker/Qoder surface.

### F. Restart reconciliation

Without model inference:

```text
agy mcp list
agy mcp add/update
Router restart equivalent
agy mcp list
```

prove `cmm-qoder-tools` remains exactly one valid registration and stale state is handled.

Reconcile/clean stale registry descriptors and enforce a meaningful disk/global bound.

### G. Make provider policy literal

For Claude/Google, unless an actual upstream parallel-control mapping is found, reject any explicit `parallel_tool_calls` field rather than claiming Router-side one-at-a-time handoff is an exact representation of `false`.

### H. Multi-step tool loop — decide separately but test before full agent-mode claim

The original Task 13 singular tool-call acceptance can remain separate from this edge remediation if desired. But full Qoder agent mode should later prove at least two sequential tool calls in one provider run.

After the deterministic edge pass:

```text
full regression x3
typecheck
build
post-build test
security audit
exact archive/capture
independent re-audit
```

Only after that independent PASS should the Claude and Antigravity subscription-backed canaries be authorized.

---

# 19. External protocol grounding used in this audit

Current OpenAI API reference, inspected 2026-09-10:

- Responses API `tool_choice` supports a function-choice object with top-level `name` and `type`.
- Chat Completions named function choice uses `{type:"function", function:{name:"..."}}`.

This difference is the basis of finding §6 and is not inferred from repository comments.

OpenAI Responses reference:
`https://developers.openai.com/api/reference/cli/resources/responses/methods/create`

OpenAI Chat Completions reference:
`https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions`

---

**Independent conclusion:** `516ccdd` is a meaningful improvement and removes the two largest previous MCP proof defects, but the deterministic phase is not yet closure-eligible. The next pass should remain narrow: API wire normalization, real process termination, bounded raw buffers, MCP request identity, stream overflow fail-closed, and restart reconciliation. No live provider canary should be run on this HEAD.
