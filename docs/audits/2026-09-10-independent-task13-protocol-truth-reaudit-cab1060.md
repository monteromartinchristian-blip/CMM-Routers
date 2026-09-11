# CMM Subscription Router — Independent Task 13 Protocol Truth Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `cab10600b4fe9831b00279e9eae04b9dd70b6bdb`
**Scope:** Task 13 — Protocol Truth & Production Wiring
**Verdict:** **FAIL**
**Live tool acceptance authorized:** **NO**

## 0. Artifact integrity and regression signal

The uploaded archive was independently verified before inspection:

```text
AUDITED_HEAD=cab10600b4fe9831b00279e9eae04b9dd70b6bdb
ARCHIVE_COMMIT=cab10600b4fe9831b00279e9eae04b9dd70b6bdb
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=5cef244c599e42289ed1510a9776e1a01c9673b601ccbefc5992eb8065f1b6d6
LOG_SHA256=df3d4ed5ca62723e6c125118cfd947236bdc6052e41dac4a4863198703c37820
GZIP_TEST=PASS
ARCHIVE_ENTRIES=541
```

The supplied Mac verification log reports:

```text
CODEX_EXPERIMENTAL_SCHEMA_RC=0
TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
TARGETED_TASK13_RC=0
LIVE_TOOL_ACCEPTANCE_RUN=NO
```

Full-suite result in the capture is `94 passed / 5 skipped` test files and
`486 passed / 25 skipped` tests. The skips remain the live-gated provider suites
and the mutation canary. This is a **strong regression signal**, not proof that
all newly claimed cross-process/provider semantics are correct.

Runtime versions captured on the audited machine:

```text
node=v26.5.0
npm=11.17.0
codex-cli=0.153.4
agy=1.2.0
@anthropic-ai/claude-agent-sdk=0.3.266
```

The `agy=1.2.0` value matters because the Task 13 design/evidence was written and
reasoned against `agy 1.1.28`, while an older source constant still says
`AGY_VERSION = "1.1.16"`. Antigravity protocol evidence is therefore stale with
respect to the binary actually installed at capture time.

---

## 1. Executive result

This pass is **substantially better** than `b891af3`. Several prior P0 findings
are genuinely fixed:

```text
CODEX_EXPERIMENTAL_DYNAMIC_TOOLS=PASS_DETERMINISTIC
CODEX_SAME_TURN_CONTINUATION=PASS_DETERMINISTIC
DEFERRED_TOOL_BROKER_PRODUCTION_WIRING=PASS
COMMAND_CODE_OPENAI_TOOL_CONTROL_BODY=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_CORE_TOOL_WIRE=PASS_DETERMINISTIC
RESPONSES_FUNCTION_CALL_LIFECYCLE=PASS_NARROW_DETERMINISTIC
TOOL_RESULT_1MIB_BOUND=PASS_DETERMINISTIC
QODER_BEARER_PROVISIONING=PASS
```

However the global Task 13 PASS is not justified. The independent audit finds
new production gaps and false-positive proofs concentrated in the Claude /
Antigravity MCP architecture and provider-control policy:

```text
CLAUDE_ACTUAL_SDK_MCP_TOOL_INVOCATION=NOT_PROVEN
CLAUDE_DETERMINISTIC_SAME_SESSION_PROOF=FALSE_POSITIVE
CLAUDE_TTL_PROVIDER_RUN_CLEANUP=FAIL

ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION=NOT_PROVEN
ANTIGRAVITY_CONCURRENT_TOOL_SESSIONS=FAIL
ANTIGRAVITY_RUNTIME_VERSION_DRIFT=REVALIDATION_REQUIRED
ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=NOT_PROVEN
ANTIGRAVITY_TTL_PROVIDER_RUN_CLEANUP=FAIL

MCP_BRIDGE_PENDING_STATE_BOUNDED=FAIL
UNDECLARED_PROVIDER_TOOL_REQUEST_FAIL_CLOSED=FAIL

CLAUDE_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
GOOGLE_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_ANTHROPIC_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP

PRODUCTION_CANCEL_POST_RESULT=FAIL/PARTIAL
GLOBAL_TASK13=FAIL
```

The right next move is a **small production-hardening pass**, not another Router
rewrite and not live acceptance yet.

---

# 2. Codex 0.153.4 — the core route is now real

## 2.1 Experimental tool declaration is correctly implemented

The exact Codex 0.153.4 protocol exposes `thread/start.dynamicTools` behind the
experimental API opt-in. The audited code now sends:

```ts
capabilities: { experimentalApi: true }
```

and maps each Qoder function tool to the schema-backed dynamic function shape:

```text
type=function
name=<Qoder function name>
description=<description or empty string>
inputSchema=<Qoder JSON schema>
deferLoading=false
```

`thread/start` receives those `dynamicTools` on the same thread that later runs
the turn. The fresh capture also regenerated the experimental Codex schema
successfully (`CODEX_EXPERIMENTAL_SCHEMA_RC=0`).

The official 0.153.4 app-server protocol confirms that `dynamicTools` and the
matching `item/tool/call` request/response flow are experimental and require
`initialize.params.capabilities.experimentalApi=true`.

### Verdict

```text
CODEX_0_153_4_DYNAMIC_TOOLS_AVAILABLE=YES
CODEX_EXPERIMENTAL_API_OPT_IN=PASS
CODEX_QODER_TOOL_DECLARATION=PASS_DETERMINISTIC
CODEX_STRICT_DECLARATION_HARNESS=PASS_DETERMINISTIC
```

## 2.2 Same-turn continuation is preserved

The adapter no longer opens a replacement Codex thread for a successful tool
continuation. It stores the original app-server request context in the shared
broker and, when Qoder returns the public tool call id, replies to the original
server request with:

```text
success=true
contentItems=[Qoder-produced result]
```

then continues draining the same `threadId` / `turnId`.

Missing `callId`, tool, threadId, turnId, or arguments now fails closed rather
than fabricating a call id.

### Verdict

```text
CODEX_MISSING_CALL_ID_FAIL_CLOSED=PASS
CODEX_PROVIDER_CALL_ID_FABRICATION=NONE
CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED=PASS_DETERMINISTIC
CODEX_SAME_THREAD_CONTINUATION=PASS_DETERMINISTIC
CODEX_SAME_TURN_CONTINUATION=PASS_DETERMINISTIC
CODEX_CHAT_AND_TOOLS=PASS_DETERMINISTIC
```

This is a real improvement and should be preserved.

## 2.3 Residual Codex guard gap: undeclared tool names

`item/tool/call` validates that `params.tool` is a non-empty string, but it does
**not** verify that the requested tool name belongs to the `request.tools`
declared on that thread. The Router therefore has no fail-closed ACL at the
provider→Qoder boundary for a misbehaving provider requesting an undeclared
function name.

That same issue exists in the shared MCP bridge (§7).

```text
CODEX_UNDECLARED_TOOL_REQUEST_FAIL_CLOSED=FAIL
```

---

# 3. DeferredToolBroker — now real production state

The previous independent audit found the broker was dead code. That is fixed.

`src/index.ts` creates one Router-owned `DeferredToolBroker`, and the Codex,
Claude, and Antigravity adapters receive it. The broker provides:

```text
maxPending=64
defaultTtlMs=120000
publicToolCallId=cmm_<provider>_<uuid>
composite provider/session/turn/call correlation
one-shot claim semantics
duplicate/late classification
scope cancellation
```

This public/provider identity split is sound for Qoder's ordinary OpenAI tool
continuation: the consumer only needs to echo the public `tool_call_id`, while
provider-native identity stays inside the Router.

### Verdict

```text
DEFERRED_TOOL_BROKER_PRODUCTION_INSTANTIATED=PASS
BROKER_PUBLIC_PROVIDER_IDENTITY_SPLIT=PASS
BROKER_PENDING_BOUND=PASS
BROKER_TTL=PASS
BROKER_DUPLICATE_RESULT_REJECTION=PASS
BROKER_LATE_RESULT_REJECTION=PASS
BROKER_CROSS_SESSION_ID_ISOLATION=PASS_DETERMINISTIC
```

But **the broker is not the only pending-state layer anymore**. The external MCP
bridge introduces unbounded queues/maps outside this broker, so the global
statement “pending tool state is bounded” is still false. See §7.2.

---

# 4. Claude — production code is wired, but the claimed deterministic proof is not

## 4.1 What production really does

The Claude adapter now creates a `BridgeControlServer`, builds an SDK
`mcpServers.cmm_qoder` config, restricts `allowedTools` to the request's MCP tool
names, and keeps an SDK iterator in a `LiveClaudeSession` while a tool call is
parked. This is materially different from the helper-only state in `b891af3`.

So:

```text
CLAUDE_ADAPTER_MCP_CONFIG_WIRING=PASS_STATIC
CLAUDE_NATIVE_BASH_READ_WRITE_EDIT_DISABLED=PASS_STATIC
CLAUDE_BROKER_WIRING=PASS_STATIC
```

## 4.2 P0 — the deterministic round-trip test bypasses the SDK MCP invocation

The test `tests/providers/claude-bridge-roundtrip.test.ts` does **not** prove
that the Claude Agent SDK invokes `mcpServers.cmm_qoder`.

The production adapter does two separate things:

1. manually spawns `bridgeCommand + bridgeEntryPath`; and
2. also passes that command to the SDK in `Options.mcpServers`.

The deterministic test captures the SDK options, but its fake `queryFn` ignores
`mcpServers`. Instead, the test grabs the **manually spawned bridge child** and
writes `initialize` and `tools/call` directly to that child's stdin. That call
therefore originates from the test, not the fake SDK.

After Qoder's result is returned to the bridge, the fake SDK still does not
continue because of that result. The test explicitly invokes `fake.release()`
to open its own Promise gate and make the fake generator emit `final-answer`.

The supposedly Router-level test
`tests/http/tool-roundtrip-production.test.ts` repeats the same structure:

```text
fake query generator blocks on local Promise gate
          +
test writes tools/call directly to manually spawned bridge
          +
test later calls releaseFn()
          ↓
"same session continuation" marker
```

Therefore the test proves these pieces independently:

```text
SDK options contain an MCP server config
external bridge transports a call/result
Router broker correlates the public id
```

but it does **not** prove the causal chain:

```text
Claude SDK -> launches/uses MCP server -> MCP tools/call -> Qoder result
          -> same SDK query resumes because its MCP call completed
```

### Verdict

```text
CLAUDE_ADAPTER_MCP_WIRING=PASS_STATIC
CLAUDE_EXTERNAL_BRIDGE_TRANSPORT=PASS_DETERMINISTIC
CLAUDE_QODER_RESULT_CORRELATION=PASS_DETERMINISTIC
CLAUDE_ACTUAL_SDK_MCP_INVOCATION=NOT_PROVEN
CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION=NOT_PROVEN
CLAUDE_DETERMINISTIC_E2E=FALSE_POSITIVE
CLAUDE_QODER_CAPABILITY=NOT_YET_ACCEPTED
```

The code may work against the real SDK; the current deterministic evidence does
not establish that fact.

## 4.3 P0/P1 — TTL cleanup does not terminate the live SDK query

`closeSession()` kills the **manually spawned** bridge and closes the Router
control socket, but it does not call:

```text
session.abortController.abort()
iterator.return()
SDK query close/interrupt
```

The TTL timer calls only `closeSession(session)`.

This directly contradicts the evidence document's claim that the 120-second TTL
prevents leaking the “live SDK query, bridge process, or control socket”. It
cleans the Router-side bridge/socket, but the SDK iterator/query may remain alive
and blocked.

```text
CLAUDE_TTL_BROKER_CLEANUP=PASS
CLAUDE_TTL_BRIDGE_SOCKET_CLEANUP=PASS
CLAUDE_TTL_PROVIDER_QUERY_CLEANUP=FAIL
CLAUDE_PROVIDER_RUN_LEAK_ON_TTL=POSSIBLE
```

The manually spawned duplicate bridge also increases lifecycle complexity
without proving anything about the SDK-owned MCP child. A corrected design
should have one authoritative MCP child lifecycle, preferably the SDK-owned
server, with an injectable SDK-faithful harness for deterministic tests.

---

# 5. Antigravity — Router plumbing exists, but two new structural blockers remain

## 5.1 Provider-side MCP invocation is still unproved

The evidence report is candid about this: no live model turn establishes that
the installed `agy` invokes the registered `cmm-qoder-tools` MCP server during
headless `--print` mode.

The deterministic Antigravity test uses a fake runner that itself behaves like
an MCP client. That validates the Router-side contract, but not the actual `agy`
process behavior.

```text
ANTIGRAVITY_ROUTER_MCP_WIRING=PASS_DETERMINISTIC
ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION=NOT_PROVEN
ANTIGRAVITY_QODER_CAPABILITY=NOT_YET_ACCEPTED
```

## 5.2 P0 — the rendezvous design fails under two concurrent Google tool sessions

`src/bridge/session-registry.ts` stores all live Antigravity session descriptors
under one global temp registry. `discoverBridgeSession()` returns a descriptor
only when:

```ts
live.length === 1
```

and the persistent `mcp-bridge-launcher` has no session id argument; it simply
calls that global discovery function.

This means two legitimate tool-capable Google requests can race as follows:

```text
Google request A -> descriptor A exists
Google request B -> descriptor B exists
agy A starts launcher -> sees two live descriptors -> FAIL
agy B starts launcher -> sees two live descriptors -> FAIL
```

The fail-closed behavior prevents cross-session leakage, which is good, but it
also prevents unrelated concurrent Qoder tool sessions from functioning. That
violates the required cross-run isolation property (“one run must not break an
unrelated run”).

### Verdict

```text
ANTIGRAVITY_SESSION_GUESSING=NONE
ANTIGRAVITY_AMBIGUITY_FAIL_CLOSED=PASS
ANTIGRAVITY_CONCURRENT_TOOL_SESSIONS=FAIL
ANTIGRAVITY_CROSS_RUN_ISOLATION=FAIL
```

A production rendezvous must route each launched MCP process to one exact
provider run without relying on “there happens to be exactly one live session
globally”.

## 5.3 MCP registration is only idempotent inside one Router process

`ensureMcpServerRegistered()` uses an in-memory boolean:

```ts
if (this.mcpRegistered) return;
this.mcpRegistrar(... agy mcp add ...);
this.mcpRegistered = true;
```

After a Router restart that flag resets, so `agy mcp add cmm-qoder-tools ...`
is attempted again. There is no preceding real `agy mcp list/read` reconciliation,
no verified update/replace behavior, and no stale-registration handling.

```text
ANTIGRAVITY_MCP_REGISTRATION_SINGLE_PROCESS_IDEMPOTENCE=PASS
ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=NOT_PROVEN
```

This must be checked against the **currently installed `agy 1.2.0`** without
model inference before any live acceptance.

## 5.4 P0/P1 — Antigravity TTL cleanup does not abort the live agy run

`closeToolSession()` removes broker state, registry descriptor, control socket,
and temp cwd, but it never calls:

```text
session.abortController.abort()
```

or otherwise terminates the in-flight `streamInference` child.

The 120-second session TTL therefore does not itself prove provider-process
cleanup. The runner has its own timeout, but that is a separate mechanism and
cannot be reported as immediate session cleanup.

```text
ANTIGRAVITY_TTL_ROUTER_STATE_CLEANUP=PASS
ANTIGRAVITY_TTL_PROVIDER_RUN_CLEANUP=FAIL
```

## 5.5 Runtime version drift

The design/evidence says `agy 1.1.28`; the capture says `agy 1.2.0`; source still
contains an unused/stale `AGY_VERSION="1.1.16"` constant.

```text
ANTIGRAVITY_PROTOCOL_VERSION_PIN=FAIL_STALE
ANTIGRAVITY_1_2_0_REVALIDATION_REQUIRED=YES
```

No live probe should be based on the old 1.1.28 assumptions without first doing
non-inference `agy --help`, `agy mcp --help/list` protocol reconnaissance on
1.2.0.

---

# 6. Command Code — major progress, but the Anthropic wire still drops caller policy

## 6.1 OpenAI wire

The concrete `CommandCodeClient.streamChatCompletion()` now serializes both:

```text
tool_choice
parallel_tool_calls
```

into the actual HTTP body, and the dedicated test inspects that emitted body.
The prior false PASS is fixed.

```text
COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY=PASS_DETERMINISTIC
COMMAND_CODE_OPENAI_PARALLEL_POLICY_HTTP_BODY=PASS_DETERMINISTIC
COMMAND_CODE_OPENAI_TOOL_WIRE=PASS_DETERMINISTIC
```

## 6.2 Anthropic Messages core tool wire

The implementation now maps Qoder definitions into Anthropic `tools[]`, parses
`tool_use` plus `input_json_delta`, and reconstructs continuation messages with
`tool_result` / `tool_use_id`. Command Code's current Provider API documentation
states that `/provider/v1/messages` follows the Anthropic Messages schema, so
this direction is protocol-correct.

```text
COMMAND_CODE_ANTHROPIC_TOOL_DECLARATION=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_TOOL_USE_PARSE=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_TOOL_RESULT_CONTINUATION=PASS_DETERMINISTIC
```

## 6.3 P1 — `tool_choice` and parallel policy are not forwarded on Anthropic wire

`runOpenAiWire()` passes `request.toolChoice` and `request.parallelToolCalls` to
its concrete client. `runAnthropicWire()` passes only:

```text
model
messages
signal
maxOutputTokens
tools
```

and `streamAnthropicMessages()` has no tool-selection / parallel-control
parameters.

At the HTTP layer, unsupported-policy rejection is special-cased only for
`provider === "chatgpt"`. Therefore a Qoder request carrying `tool_choice` or
`parallel_tool_calls` for a Command Code Anthropic model is accepted and those
constraints disappear before reaching the provider.

```text
COMMAND_CODE_ANTHROPIC_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_ANTHROPIC_PARALLEL_POLICY=FAIL_SILENT_DROP
SILENT_TOOL_CHOICE_DROP=NOT_NONE
SILENT_PARALLEL_TOOL_POLICY_DROP=NOT_NONE
```

If Command Code/Anthropic cannot represent an exact requested policy, the Router
must reject it explicitly instead of discarding it.

---

# 7. Shared MCP bridge — two security/correctness gaps

## 7.1 P0 — `tools/call` does not enforce the declared tool set

`mcp-bridge-process.ts` advertises the request's tools from
`CMM_BRIDGE_TOOLS` on `tools/list`. But on `tools/call` it only checks that
`params.name` is a string; it never verifies that the name is in the advertised
set.

It then forwards that arbitrary name over the control channel. The Claude and
Antigravity adapters subsequently surface `request.name` directly to Qoder.

The Codex dynamic-tool handler similarly validates only “non-empty tool name”,
not membership in the dynamicTools originally declared to Codex. Command Code
also lacks a central provider-call-name ACL.

A provider/MCP client should never be able to ask Qoder to execute an undeclared
function and rely on Qoder itself to reject it.

```text
DECLARED_TOOL_ACL_AT_PROVIDER_BOUNDARY=FAIL
UNDECLARED_PROVIDER_TOOL_REQUEST_FAIL_CLOSED=FAIL
QODER_TOOL_SURFACE_IS_STRICT_SUBSET_OF_REQUEST_TOOLS=NOT_PROVEN
```

Fix centrally or per adapter, but the decision must be request/session scoped
and schema/name exact.

## 7.2 P0/P1 — bridge pending state is unbounded outside DeferredToolBroker

The broker itself is bounded to 64 pending entries. However
`BridgeControlServer` has:

```ts
private readonly pending = new Map<string, PendingFrame>();
```

with no maximum and no per-entry TTL. Claude and Antigravity also use simple
`AsyncQueue<T>` implementations backed by unbounded arrays.

A provider-side MCP server can therefore enqueue multiple concurrent tool calls
while Qoder is resolving an earlier one. Those calls sit in the control map / queue
before they enter the bounded broker.

```text
DEFERRED_TOOL_BROKER_PENDING_BOUND=PASS
MCP_CONTROL_PENDING_BOUND=FAIL
MCP_TOOL_EVENT_QUEUE_BOUND=FAIL
GLOBAL_PENDING_TOOL_STATE_BOUNDED=FAIL
```

This is a bounded-state requirement violation and a local resource-exhaustion
surface. Add a small per-session max and TTL/cancel rejection at the control
layer as well as the broker layer.

---

# 8. Tool policy — global claim is false for Claude and Google too

The audit found provider-control handling only in:

```text
HTTP parser
Codex rejection policy
Command Code OpenAI wire
```

Neither `ClaudeAdapter` nor `AntigravityAdapter` reads `request.toolChoice` or
`request.parallelToolCalls`.

Therefore the evidence report's global markers:

```text
SILENT_TOOL_CHOICE_DROP=NONE
SILENT_PARALLEL_TOOL_POLICY_DROP=NONE
```

are false outside Codex and Command Code OpenAI.

### Verdict

```text
CLAUDE_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
CLAUDE_PARALLEL_TOOL_POLICY=FAIL_SILENT_DROP
GOOGLE_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
GOOGLE_PARALLEL_TOOL_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_ANTHROPIC_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_ANTHROPIC_PARALLEL_POLICY=FAIL_SILENT_DROP
```

For each wire, either map the semantics faithfully or return an explicit
`unsupported_capability` before provider execution.

---

# 9. Responses API — the specific Task 13 function-call defects are fixed

The previous `call_id ?? id` false-positive assertion is gone. Non-streaming
function-call output now has an output item id distinct from `call_id`.

Streaming emits the expected function-call lifecycle used by the Task 13
contract:

```text
response.output_item.added
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed
```

with output index, item id and assembled arguments. This matches the current
OpenAI Responses function-call event model at the level Task 13 targets.

### Verdict

```text
RESPONSES_FUNCTION_CALL_ITEM_ID=PASS_DETERMINISTIC
RESPONSES_FUNCTION_CALL_CALL_ID=PASS_DETERMINISTIC
RESPONSES_CALL_ID_DISTINCT_FROM_ITEM_ID=PASS_DETERMINISTIC
RESPONSES_ARGUMENTS_DELTA=PASS_DETERMINISTIC
RESPONSES_ARGUMENTS_DONE=PASS_DETERMINISTIC
RESPONSES_OUTPUT_ITEM_LIFECYCLE=PASS_NARROW_DETERMINISTIC
```

This should be preserved. It is not a claim that every field/event of the full
OpenAI Responses API is implemented; it closes the Task 13 function-tool subset.

---

# 10. Tool-result size and logging

The previous vacuous `"x".repeat()` size test has been replaced with an actual
HTTP-boundary guard. `MAX_TOOL_RESULT_BYTES` is one MiB and an oversized Qoder
tool result is rejected before the provider adapter is invoked.

```text
TOOL_RESULT_SIZE_BOUND=PASS_DETERMINISTIC
OVERSIZE_TOOL_RESULT_REJECTED_BEFORE_PROVIDER=PASS_DETERMINISTIC
```

The sentinel logging test passes through HTTP, Claude adapter, broker and bridge,
and captures process stdout/stderr. That is much stronger than the prior helper
counter test. However its “full same-session provider path” label inherits the
Claude fake-SDK flaw described in §4.2. The narrow logging conclusion is still
useful because the actual content traverses the Router/bridge path and the
captured sinks do not contain it.

```text
TOOL_ARGUMENT_LOGGING=NONE_DETERMINISTIC_PATH
TOOL_RESULT_LOGGING=NONE_DETERMINISTIC_PATH
```

---

# 11. Cancellation / lifetime — global PASS remains unsupported

The Qoder final report itself said:

```text
PRODUCTION_CANCEL_POST_RESULT=PARTIAL
```

while declaring `CMM_SUBSCRIPTION_ROUTER_TASK13_PROTOCOL_TRUTH=PASS`.
That is internally inconsistent with the phase acceptance criterion.

The independent source audit additionally shows:

- Claude's TTL closes Router bridge state but does not abort the SDK query;
- Antigravity's TTL closes Router state but does not abort `streamInference`;
- `cancel(requestId)` intentionally preserves a parked MCP session because the
  first HTTP response's normal socket close is indistinguishable from a cancel;
- the exhaustive HTTP cancellation matrix is not implemented for the two MCP
  providers.

The architectural difficulty here is real: a normal split tool round-trip must
survive the first HTTP response, while an actual user cancellation must still be
representable. The current request-id teardown contract does not encode that
distinction after parking.

### Verdict

```text
BROKER_UNIT_CANCELLATION=PASS
CODEX_PRODUCTION_CANCEL_PATH=PASS/PARTIAL_STRONG
CLAUDE_PARKED_SESSION_CANCEL=TTL_ONLY
GOOGLE_PARKED_SESSION_CANCEL=TTL_ONLY
CLAUDE_TTL_PROVIDER_RUN_CLEANUP=FAIL
GOOGLE_TTL_PROVIDER_RUN_CLEANUP=FAIL
PRODUCTION_CANCEL_POST_RESULT=FAIL/PARTIAL
PRODUCTION_MCP_CANCELLATION_MATRIX=NOT_PROVEN
```

Task 13 cannot globally PASS with this field explicitly partial.

---

# 12. Antigravity version evidence is stale

The audited capture says:

```text
agy 1.2.0
```

but the design and evidence repeatedly say:

```text
agy 1.1.28
```

and `src/providers/antigravity/process-client.ts` contains:

```ts
export const AGY_VERSION = "1.1.16";
```

The constant appears unused, but this three-version disagreement means the
claimed exact CLI protocol reconnaissance is not tied to the runtime that will
execute the live acceptance probe.

Before any inference, re-run allowed non-model checks against 1.2.0:

```text
agy --version
agy --help
agy mcp --help
agy mcp list
```

and verify registration/update behavior and command argument order. Do not
consume model quota for this discovery.

---

# 13. What genuinely passed and should not be reopened

```text
REGRESSION_SIGNAL=STRONG
CMMCHAT_CHAT_ONLY_BOUNDARY=PASS
QODER_BEARER_AUTH_BOUNDARY=PASS
PAYG_GUARDS=PASS_BASELINE
LOOPBACK_BASELINE=PASS

CODEX_EXPERIMENTAL_DYNAMIC_TOOLS=PASS_DETERMINISTIC
CODEX_STRICT_DECLARATION=PASS_DETERMINISTIC
CODEX_SAME_THREAD_TURN_CONTINUATION=PASS_DETERMINISTIC
CODEX_PROVIDER_ID_FABRICATION=NONE

DEFERRED_TOOL_BROKER_PRODUCTION_COMPOSITION=PASS
DEFERRED_TOOL_BROKER_PUBLIC_IDENTITY=PASS
DEFERRED_TOOL_BROKER_BOUND_TTL=PASS

COMMAND_CODE_OPENAI_BODY_FORWARDING=PASS_DETERMINISTIC
COMMAND_CODE_ANTHROPIC_CORE_TOOL_WIRE=PASS_DETERMINISTIC

RESPONSES_TASK13_FUNCTION_CALL_LIFECYCLE=PASS_DETERMINISTIC
TOOL_RESULT_1MIB_BOUND=PASS_DETERMINISTIC
QODER_BEARER_PROVISIONING=PASS
NO_PROVIDER_NATIVE_EDIT_PATH_INTRODUCED=PASS_STATIC
```

The remaining failure is narrow enough that another wholesale redesign would
be counterproductive.

---

# 14. Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_PROTOCOL_TRUTH_REAUDIT=FAIL

AUDITED_HEAD=cab10600b4fe9831b00279e9eae04b9dd70b6bdb
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=5cef244c599e42289ed1510a9776e1a01c9673b601ccbefc5992eb8065f1b6d6
LOG_SHA256=df3d4ed5ca62723e6c125118cfd947236bdc6052e41dac4a4863198703c37820
REGRESSION_SIGNAL=STRONG

CMMCHAT_CHAT_ONLY=PASS
QODER_AUTH_BOUNDARY=PASS

DEFERRED_TOOL_BROKER_PRODUCTION_WIRING=PASS
DEFERRED_TOOL_BROKER_BOUND=PASS
MCP_CONTROL_PENDING_BOUND=FAIL
MCP_TOOL_QUEUE_BOUND=FAIL
GLOBAL_PENDING_TOOL_STATE_BOUNDED=FAIL

CODEX_EXPERIMENTAL_API_OPT_IN=PASS
CODEX_DYNAMIC_TOOLS_SENT=PASS
CODEX_STRICT_DECLARATION_E2E=PASS_DETERMINISTIC
CODEX_SAME_THREAD_CONTINUATION=PASS_DETERMINISTIC
CODEX_SAME_TURN_CONTINUATION=PASS_DETERMINISTIC
CODEX_UNDECLARED_TOOL_REQUEST_FAIL_CLOSED=FAIL
CODEX_CHAT_AND_TOOLS=PASS_DETERMINISTIC_WITH_GUARD_GAP

COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY=PASS
COMMAND_CODE_OPENAI_PARALLEL_POLICY_HTTP_BODY=PASS
COMMAND_CODE_ANTHROPIC_TOOL_DECLARATION=PASS
COMMAND_CODE_ANTHROPIC_TOOL_USE_PARSE=PASS
COMMAND_CODE_ANTHROPIC_TOOL_RESULT_CONTINUATION=PASS
COMMAND_CODE_ANTHROPIC_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_ANTHROPIC_PARALLEL_POLICY=FAIL_SILENT_DROP
COMMAND_CODE_STAR_REQUIREMENT=FAIL_POLICY

CLAUDE_ADAPTER_MCP_CONFIG_WIRING=PASS_STATIC
CLAUDE_EXTERNAL_BRIDGE_TRANSPORT=PASS_DETERMINISTIC
CLAUDE_ACTUAL_SDK_MCP_INVOCATION=NOT_PROVEN
CLAUDE_DETERMINISTIC_SAME_SESSION_TEST=FALSE_POSITIVE
CLAUDE_TTL_PROVIDER_RUN_CLEANUP=FAIL
CLAUDE_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
CLAUDE_PARALLEL_POLICY=FAIL_SILENT_DROP
CLAUDE_QODER_CAPABILITY=NOT_YET_ACCEPTED

ANTIGRAVITY_ROUTER_MCP_WIRING=PASS_DETERMINISTIC
ANTIGRAVITY_PROVIDER_SIDE_MCP_INVOCATION=NOT_PROVEN
ANTIGRAVITY_CONCURRENT_TOOL_SESSIONS=FAIL
ANTIGRAVITY_CROSS_RUN_ISOLATION=FAIL
ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=NOT_PROVEN
ANTIGRAVITY_RUNTIME_CAPTURE=1.2.0
ANTIGRAVITY_EVIDENCE_VERSION=1.1.28
ANTIGRAVITY_TTL_PROVIDER_RUN_CLEANUP=FAIL
ANTIGRAVITY_TOOL_CHOICE_POLICY=FAIL_SILENT_DROP
ANTIGRAVITY_PARALLEL_POLICY=FAIL_SILENT_DROP
GOOGLE_QODER_CAPABILITY=FAIL_PENDING_REMEDIATION

DECLARED_TOOL_ACL_AT_PROVIDER_BOUNDARY=FAIL
UNDECLARED_PROVIDER_TOOL_REQUEST_FAIL_CLOSED=FAIL

RESPONSES_TASK13_FUNCTION_CALL_LIFECYCLE=PASS_DETERMINISTIC
TOOL_RESULT_SIZE_BOUND=PASS
TOOL_ARGUMENT_LOGGING=NONE_DETERMINISTIC_PATH
TOOL_RESULT_LOGGING=NONE_DETERMINISTIC_PATH

PRODUCTION_CANCEL_POST_RESULT=FAIL_PARTIAL
PRODUCTION_MCP_CANCELLATION_MATRIX=NOT_PROVEN

QODER_BEARER_PROVISIONING=PASS
QODER_FRESH_MAC_REPRODUCIBILITY=PASS

API_PAYG_FALLBACK=NONE_BASELINE
CROSS_PROVIDER_FALLBACK=NONE_BASELINE
UNKNOWN_MODEL_FALLBACK=NONE_BASELINE
COMMAND_CODE_ON_DEMAND=NONE_BASELINE

LIVE_TOOL_ACCEPTANCE_RUN=NO
LIVE_TOOL_ACCEPTANCE_AUTHORIZED=NO

TASK13_QODER_REQUIREMENT=NOT_MET
FINAL_CLOSURE_ELIGIBLE=NO

NEXT=TASK13_MCP_HARDENING_AND_PROVIDER_POLICY_PASS
```

---

# 15. Required next pass — narrow remediation only

## A. Declared-tool ACL (all provider paths)

Before surfacing any provider-requested function to Qoder, check the tool name
against the exact request/session declaration set. Unknown names fail closed.
Add adversarial tests for Codex, Claude bridge, Antigravity bridge and Command
Code.

## B. Bound the MCP control layer

Add finite per-session limits and TTL/cancel behavior to:

```text
BridgeControlServer.pending
Claude AsyncQueue<BridgeToolRequest>
Antigravity AsyncQueue<BridgeToolRequest>
```

A flood of provider tool calls must not bypass the broker's `maxPending` simply
by waiting one layer earlier.

## C. Claude: remove the false-positive harness

Build an SDK-faithful deterministic seam where the fake SDK itself consumes the
provided `mcpServers` config, launches the MCP server, sends `tools/call`, blocks
on that call, and only continues when the returned MCP result resolves it.

Do **not** let the test write directly to an unrelated manually spawned bridge
and do **not** use an independent `release()` Promise as the cause of provider
continuation.

Prefer removing the redundant manually spawned bridge from production if the
SDK owns the MCP child. Ensure TTL/session close aborts the SDK query and closes
its iterator/lifecycle.

## D. Antigravity: replace global-single-session rendezvous

The MCP launcher must bind to the exact agy run even when multiple tool sessions
are alive concurrently. “Discover the only live session globally” is not a
production correlation strategy.

Also make persistent registration idempotent across Router restarts by
reconciling the existing `cmm-qoder-tools` registration before add/update.

Revalidate all non-inference CLI assumptions against the installed `agy 1.2.0`.

## E. Provider tool-choice / parallel policy

For Claude, Google and Command Code Anthropic:

- forward native semantics if the actual wire supports them; or
- reject unsupported constraints consistently at the HTTP boundary.

Never accept and silently drop.

## F. Cancellation/lifetime

`closeSession()` / `closeToolSession()` must terminate the actual live provider
run on TTL/error/explicit terminal cleanup. Add per-provider deterministic tests
for:

```text
waiting for tool result
result accepted, provider continuation hangs
provider continuation crashes
tool session TTL
bridge process exits
concurrent unrelated session survives
```

## G. Then independent re-audit, then live

After this narrow pass:

1. full regression x3 + build/typecheck/security;
2. exact git archive + verification capture;
3. independent re-audit;
4. only if that passes, authorize the smallest subscription-backed live canary
   for Claude and Antigravity (and Codex/Command Code as needed), with no repo
   mutation and no PAYG fallback.

Do **not** run the Antigravity live probe on the current HEAD.
