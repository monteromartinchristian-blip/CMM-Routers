# CMM Subscription Router — Independent Task 13 Completion Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `b891af36a02e88a02151d845abf83f64c2e3d051`
**Scope:** Task 13 — Qoder Tool Calling / Deferred Tool Broker & Provider Wire Completion
**Verdict:** **FAIL**

## 0. Artifact integrity and regression signal

The uploaded archive was independently verified before inspection:

```text
AUDITED_HEAD=b891af36a02e88a02151d845abf83f64c2e3d051
ARCHIVE_COMMIT=b891af36a02e88a02151d845abf83f64c2e3d051
BUNDLE_SHA256=e6f471a7f8243f1daf6cc197463b8fb06099cd2aec9aad91276da674522b8d5b
LOG_SHA256=99805a1f3c16aab5530b5a26cd6acc2d94cf7e01fb0eb97d0bc84bfe09bb72a5
GZIP_TEST=PASS
ARCHIVE_FILES=473
```

The preserved late Claude patch is explicitly outside the audited HEAD:

```text
LATE_CLAUDE_PATCH_SHA256=b6cd3442fa50ea69222de332ba2878fc970a495421497058f11647aa312334a4
LATE_PATCH_INCLUDED_IN_AUDITED_HEAD=NO
```

The supplied machine verification is a strong regression signal:

```text
TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
TARGETED_TASK13_RC=0
OPENAI_PAYG_POISON_RC=1
ANTHROPIC_PAYG_POISON_RC=1
GOOGLE_PAYG_POISON_RC=1
LIVE_TOOL_ACCEPTANCE_RUN=NO
```

These results establish that the branch is stable under its current tests. They do **not** establish Task 13 correctness, because several of the new tests validate isolated helpers rather than the production provider paths, and one key Codex research conclusion is factually wrong.

---

# 1. P0 — The Codex 0.153.4 “no tool declaration channel” blocker is false

This is the most important finding in this reaudit.

The design and evidence documents conclude that Codex 0.153.4 has no client→server dynamic tool declaration channel because the generated `ThreadStartParams` fixture contains no `tools`/`dynamicTools`, and `DynamicToolSpec` appears orphaned.

That conclusion came from generating the **stable-only** schema.

The official OpenAI Codex source at the exact `rust-v0.153.4` tag defines this field on `ThreadStartParams`:

```rust
#[experimental("thread/start.dynamicTools")]
pub dynamic_tools: Option<Vec<DynamicToolSpec>>,
```

The official v0.153.4 app-server README also documents:

```text
thread/start.dynamicTools = experimental
initialize.params.capabilities.experimentalApi = true
```

and explicitly says schema generation defaults to the stable API surface. Experimental fields only appear with:

```bash
codex app-server generate-json-schema --out DIR --experimental
```

The repository provenance currently records only:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema-fresh
```

without `--experimental`.

Therefore the observed “fresh schema is byte-identical and contains no dynamicTools” result is expected and does **not** prove absence of the API.

Production confirms the missing opt-in:

`src/providers/codex/adapter.ts:593-599`

```ts
await this.client.initialize({
  clientInfo: {
    name: "cmm-subscription-router",
    title: "CMM Subscription Router",
    version: "0.1.0",
  },
});
```

No `capabilities.experimentalApi: true` is sent.

Production thread creation also omits dynamic tool definitions:

`src/providers/codex/adapter.ts:218-225`

```ts
const threadParams = buildThreadStartParams({
  model: request.model.upstreamModel,
  sandbox: "read-only",
  developerInstructions: ...,
  ephemeral: true,
});
```

and the local schema-backed type omits the experimental field:

`src/providers/codex/schema-protocol.ts:69-76`.

### Consequence

Arbitrary Qoder tools **are representable in Codex 0.153.4**. The correct route is:

```text
initialize(capabilities.experimentalApi=true)
        ↓
thread/start(dynamicTools = Qoder tool schemas)
        ↓
Codex sees Qoder tools
        ↓
item/tool/call
        ↓
Qoder executes
        ↓
DynamicToolCallResponse success:true
        ↓
same turn continues
```

No prompt-injected fake schema and no Codex-native shell/file execution are required.

Verdict:

```text
CODEX_0_153_4_DYNAMIC_TOOLS_AVAILABLE=YES
CODEX_EXPERIMENTAL_API_OPT_IN_IMPLEMENTED=NO
CODEX_QODER_TOOL_DEFINITIONS_SENT=NO
CODEX_NO_DECLARATION_CHANNEL_BLOCKER=FALSE
CODEX_CHAT_AND_TOOLS=FAIL
```

### Required correction

1. Generate and track an **experimental** 0.153.4 schema fixture separately from the stable fixture.
2. Add `capabilities: { experimentalApi: true }` to Codex initialize.
3. Extend the schema-backed `ThreadStartParams` with `dynamicTools` from the experimental schema.
4. Map every Qoder OpenAI function tool to Codex `DynamicToolSpec::Function`:
   - `name`
   - `description`
   - `inputSchema`
   - `deferLoading: false`
5. Create a strict fake app-server that rejects `thread/start` unless it receives the expected `dynamicTools` payload.

Official source references:

- https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/app-server/README.md
- https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/protocol/src/dynamic_tools.rs

---

# 2. P0 — The DeferredToolBroker is dead production code

The new shared broker is implemented and has useful isolated tests, but no production adapter imports or instantiates it.

Repository-wide production search:

```text
src/core/deferred-tool-broker.ts:42: export class DeferredToolBroker
```

There are **no** production references to:

```text
new DeferredToolBroker(...)
DeferredToolBroker
cmm_session_id
```

outside the class definition itself.

This directly contradicts the design/evidence claim that provider pending state is bounded and correlated by:

```text
consumer + provider + sessionId + turnId + toolCallId
```

### Actual Codex state

`src/providers/codex/adapter.ts:117-120` uses its own raw map:

```ts
private readonly pendingTools = new Map<
  string,
  { wireId: number | string; threadId: string; turnId: string; tool: string; argsJson: string }
>();
```

The key is **only `callId`**.

Follow-up resolution at `src/providers/codex/adapter.ts:198-210` does:

```ts
const pending = this.pendingTools.get(result.toolCallId as string);
this.pendingTools.delete(result.toolCallId as string);
this.client.respondToServerRequest(pending.wireId, { success: true, ... });
```

There is no validation of provider session/thread/turn/request ownership at the Qoder result boundary.

There is also:

```text
NO maxPending bound
NO TTL
NO terminal-state tracking
NO duplicate-call-id refusal
NO pendingTools cleanup in cancel()
NO provider-death cleanup of pendingTools
```

Two concurrent Codex calls with the same provider `callId` can overwrite one another. A late pending call can remain in memory indefinitely. A Qoder request carrying a matching call id can resolve an entry without proving which HTTP/tool loop it belongs to.

Verdict:

```text
DEFERRED_TOOL_BROKER_CORE=PASS_ISOLATED
DEFERRED_TOOL_BROKER_PRODUCTION_WIRING=FAIL
CODEX_PENDING_STATE_BOUNDED=NO
CODEX_PENDING_TTL=NONE
CODEX_COMPOSITE_CORRELATION=NO
CODEX_CROSS_REQUEST_RESULT_ISOLATION=NOT_PROVEN
```

This is a P0 correctness/security blocker before any live tool acceptance.

---

# 3. Codex same-turn continuation itself is materially improved

The previous `success:false` / new-thread workaround has been replaced.

The current adapter now:

- holds the original `item/tool/call` server request;
- preserves `wireId`, `threadId`, `turnId`, and `callId`;
- surfaces a structured tool call to Qoder;
- later answers the **original** JSON-RPC request with `success:true` and Qoder's result;
- calls `drainTurn()` on the same thread/turn;
- does not open a second thread on the successful continuation path.

The new deterministic test `tests/providers/codex-same-turn-continuation.test.ts` is substantially stronger than the deleted old fake E2E and validates the same-turn half of the wire.

So this subcomponent earns a narrow PASS:

```text
CODEX_DYNAMIC_TOOL_REQUEST_HELD_PENDING=PASS_DETERMINISTIC
CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED=PASS_DETERMINISTIC
CODEX_DYNAMIC_TOOL_RESPONSE_SUCCESS_TRUE=PASS_DETERMINISTIC
CODEX_SAME_THREAD_CONTINUATION=PASS_DETERMINISTIC
CODEX_SAME_TURN_CONTINUATION=PASS_DETERMINISTIC
```

But that does **not** make `chatgpt/*` tool-capable yet, because the model never receives the Qoder tool definitions and the pending-call state is not safely brokered.

### Additional Codex fail-closed defect

`src/providers/codex/adapter.ts:321-325` synthesizes a call id when the required protocol field is absent:

```ts
const callId =
  typeof params.callId === "string" && params.callId.length > 0
    ? params.callId
    : `call-${Date.now().toString(36)}`;
```

The 0.153.4 schema requires `callId`. Missing/empty `callId` should produce `provider_protocol_error`, not a fabricated ID. The same principle applies to a missing/invalid `tool` name.

```text
CODEX_MISSING_CALL_ID_FAIL_CLOSED=FAIL
CODEX_EXACT_PROVIDER_CALL_ID_PRESERVATION=PARTIAL
```

---

# 4. P0 — Claude and Antigravity are helpers, not wired provider prototypes

The evidence document is partially candid that both capabilities remain `CHAT_ONLY`, but the final report labels multiple fields `WIRED`. Static inspection shows they are not wired into the live adapter paths.

## 4.1 Claude

`src/providers/claude/deferred-tools.ts` contains useful typed helpers:

- `buildDeferMatcher()`
- `withDeferHooks()`
- `deferredToToolCall()`

`src/providers/claude/mcp-bridge.ts` contains a minimal stdio MCP server helper.

However `src/providers/claude/adapter.ts` imports neither file.

The live `run()` path:

- constructs ordinary SDK `Options`;
- disables native tools;
- does **not** set `mcpServers`;
- does **not** attach `PreToolUse` defer hooks;
- does **not** inspect `deferred_tool_use`;
- does **not** persist `session_id` for tool continuation;
- does **not** resume via `query({ options: { resume } })`.

All discovered Claude models remain:

```ts
capability: "CHAT_ONLY"
```

Further, `spawnMcpBridge()` currently throws unconditionally:

```ts
throw new Error("spawnMcpBridge is configured at deployment time via `agy mcp add`; see docs/macos-install.md");
```

That message conflates the Antigravity deployment mechanism with Claude's Agent SDK path.

The test `tests/providers/claude-deferred-bridge.test.ts` does not run the Claude adapter through defer→Qoder→resume. It tests helper shapes and prints `WIRED` labels.

Verdict:

```text
CLAUDE_DEFER_HELPER_SHAPE=PASS_ISOLATED
CLAUDE_MCP_HELPER=PASS_ISOLATED
CLAUDE_ADAPTER_MCP_WIRING=FAIL
CLAUDE_DEFERRED_TOOL_USE_HANDLING=FAIL
CLAUDE_SAME_SESSION_RESUME_IMPLEMENTED=NO
CLAUDE_CHAT_AND_TOOLS=FAIL
```

A live Claude tool test is **not yet authorized** because production wiring is absent; live inference would not validate the proposed architecture.

## 4.2 Antigravity

`src/providers/antigravity/mcp-bridge.ts` is essentially a re-export of the Claude helper plus:

```ts
return `agy mcp add cmm-qoder-tools ${bridgePath}`;
```

`src/providers/antigravity/adapter.ts` does not import or reference this bridge at all. It still runs the existing text-only headless flow:

```text
agy --print <prompt> --output-format stream-json --model ... --mode plan --sandbox
```

and all Google models remain `CHAT_ONLY`.

There is no production path that:

- installs/configures the bridge;
- parks an MCP request into the Router broker;
- surfaces the call to Qoder;
- accepts Qoder's result;
- releases the pending MCP call;
- keeps the same Antigravity run alive.

Verdict:

```text
ANTIGRAVITY_MCP_HELPER=PASS_ISOLATED
ANTIGRAVITY_ADAPTER_MCP_WIRING=FAIL
ANTIGRAVITY_PENDING_MCP_CONTINUATION_IMPLEMENTED=NO
GOOGLE_CHAT_AND_TOOLS=FAIL
```

A live Antigravity tool test is also **not yet authorized** until production wiring exists.

---

# 5. Command Code — OpenAI wire improved, but tool-control semantics are still dropped

Two prior defects are genuinely fixed on the OpenAI wire:

```text
COMMAND_CODE_ASSISTANT_TOOL_HISTORY=PASS_STATIC/DETERMINISTIC
COMMAND_CODE_FRAGMENTED_TOOL_INDEX_CORRELATION=PASS_STATIC/DETERMINISTIC
```

`toUpstreamMessages()` now preserves assistant `tool_calls`, and the stream parser uses upstream `tool_calls[].index` instead of inventing a local index.

However the claimed `tool_choice` / `parallel_tool_calls` forwarding does **not** reach the actual HTTP request.

The adapter passes these properties to `streamChatCompletion()`:

`src/providers/command-code/adapter.ts:241-250`

```ts
{
  maxOutputTokens,
  tools,
  tool_choice: request.toolChoice,
  parallel_tool_calls: request.parallelToolCalls,
}
```

But the concrete client signature at `src/providers/command-code/client.ts:613-633` is:

```ts
options: { maxOutputTokens?: number; tools?: unknown[] } = {}
```

and the body builder only copies:

```ts
max_tokens
 tools
```

The extra properties passed by the adapter are never read and therefore never serialized.

The new test `tests/http/tool-choice-forwarding.test.ts` only verifies that HTTP parsing puts the values on `RouterRequest`; it uses a capture adapter and never inspects the real Command Code upstream body.

Verdict:

```text
TOOL_CHOICE_HTTP_TO_ROUTER_REQUEST=PASS
PARALLEL_TOOL_CALLS_HTTP_TO_ROUTER_REQUEST=PASS
COMMAND_CODE_TOOL_CHOICE_UPSTREAM_FORWARDING=FAIL
COMMAND_CODE_PARALLEL_TOOL_CALLS_UPSTREAM_FORWARDING=FAIL
TOOL_CHOICE_PRESERVED_END_TO_END=FAIL
```

## 5.1 Anthropic-wire Command Code remains unnecessarily abandoned

The adapter still advertises every `anthropic-messages` model as `CHAT_ONLY` and comments that the wire “cannot express this structured round-trip.”

That conclusion is not supported by the protocol contract.

Command Code's official Provider API documentation says `/provider/v1/messages` request and response bodies follow the **Anthropic Messages schema**. Anthropic Messages natively supports client-defined tools: request `tools`, receive structured `tool_use`, execute client-side, then send `tool_result` on the next request.

Thus the correct status is not “no channel”; it is “not implemented/tested in this Router.”

Current `buildAnthropicRequestBody()` explicitly flattens messages to string content and emits no `tools`. `parseAnthropicEvent()` ignores `content_block_start` tool-use blocks and `input_json_delta` argument chunks.

Verdict:

```text
COMMAND_CODE_OPENAI_WIRE_CHAT_AND_TOOLS=PARTIAL_PASS
COMMAND_CODE_ANTHROPIC_WIRE_CHAT_AND_TOOLS=NOT_IMPLEMENTED
COMMAND_CODE_ANTHROPIC_NO_TOOL_CHANNEL_CLAIM=NOT_PROVEN
COMMAND_CODE_STAR_REQUIREMENT=FAIL
```

Official references:

- https://commandcode.ai/docs/provider
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

---

# 6. P1 — Responses API still contains two false PASSes

## 6.1 Input parsing is fixed

The Router now accepts canonical top-level:

```text
function_call
function_call_output
```

and converts them to internal assistant tool-call history / tool result messages.

```text
RESPONSES_FUNCTION_CALL_OUTPUT_INPUT_PARSE=PASS
```

## 6.2 Non-streaming output omits canonical `call_id`

At `src/http/openai-responses.ts:322-327`, function calls are emitted as:

```ts
{
  type: "function_call",
  id: call.id,
  name: call.name,
  arguments: call.arguments,
}
```

The Responses function-call object has a distinct `call_id` used to submit `function_call_output`.

The test hides the defect:

`tests/http/responses-function-call-output.test.ts:68-69`

```ts
expect(call?.call_id ?? call?.id).toBe("call-resp-1");
```

Accepting `id` as a substitute means the test cannot prove canonical `call_id` round-trip semantics.

```text
RESPONSES_FUNCTION_CALL_ID_ROUNDTRIP=FAIL
RESPONSES_FUNCTION_CALL_ID_TEST=FALSE_POSITIVE
```

## 6.3 Streaming function-call lifecycle is incomplete

For tool calls, the current stream emits only:

```text
response.function_call_arguments.delta
response.completed
```

The delta currently contains:

```json
{
  "item_id": "<tool call id>",
  "delta": "...",
  "name": "..."
}
```

It omits required/standard lifecycle information such as `output_index`, and there is no `response.output_item.added` function-call item or `response.function_call_arguments.done` event carrying the finalized call metadata.

No targeted test in the archive asserts these streaming semantics.

```text
RESPONSES_STREAMING_TOOL_SEMANTICS=FAIL
RESPONSES_STREAMING_TOOL_TEST=ABSENT
```

Official reference:

- https://platform.openai.com/docs/api-reference/responses-streaming

---

# 7. P1 — The cancellation/isolation matrix mostly tests an unused helper

`tests/providers/deferred-tool-cancellation.test.ts` instantiates `DeferredToolBroker` directly. It does not run the actual Codex, Claude, Antigravity or Command Code adapters through the Qoder HTTP tool boundary.

Because production does not use that broker, markers such as:

```text
CANCEL_DURING_TOOL_CALL=PASS
CANCEL_WAITING_FOR_TOOL_RESULT=PASS
ACTIVE_TOOL_STATE_AFTER_TIMEOUT=0
```

prove the helper's behavior, not the production tool loops.

`tests/providers/deferred-tool-isolation.test.ts` has the same issue for cross-session isolation.

Two particularly weak tests are effectively vacuous:

### “huge tool results are bounded (1MiB cap)”

```ts
const huge = "x".repeat(2 * 1024 * 1024);
expect(huge.length).toBeGreaterThan(1024 * 1024);
```

No Router/provider code is called and no 1 MiB limit is enforced.

### “malformed JSON arguments fail closed before broker insert”

```ts
expect(() => JSON.parse("{not json")).toThrow();
const broker = new DeferredToolBroker(...);
expect(broker.activeCount()).toBe(0);
```

Again, no provider/HTTP path is exercised.

The content-logging test similarly checks only the broker's public counter/resolve surface and does not inspect telemetry/log output.

Verdict:

```text
BROKER_UNIT_CANCELLATION=PASS
PRODUCTION_TOOL_BOUNDARY_CANCELLATION_MATRIX=NOT_PROVEN
PRODUCTION_CROSS_REQUEST_TOOL_ISOLATION=NOT_PROVEN
TOOL_RESULT_1MIB_BOUND=NOT_IMPLEMENTED_OR_NOT_PROVEN
MALFORMED_TOOL_ARGUMENT_FAIL_CLOSED=NOT_PROVEN_IN_PRODUCTION
TOOL_CONTENT_LOGGING_INTEGRATED_PROOF=NOT_PROVEN
```

These tests must be moved up one layer: actual provider adapter + Router HTTP boundary, with the production broker wired in.

---

# 8. Launchd Qoder token lookup is fixed, provisioning is incomplete

The runtime wrapper now correctly attempts to load `CMM_QODER_TOKEN` from Keychain using the configured service/account, and the plist contains identifiers only. That part is a real improvement:

```text
LAUNCHD_QODER_TOKEN_LOOKUP=PASS
TRACKED_QODER_SECRET_VALUE=NONE
```

However the installation/provisioning path is incomplete.

`docs/macos-install.md` currently documents Keychain creation for:

```bash
security add-generic-password -s cmm-subscription-router -a router-bearer -w
security add-generic-password -s cmm-subscription-router -a command-code-secret -w
```

but does not document/provision:

```bash
security add-generic-password -s cmm-subscription-router -a qoder-bearer -w
```

The installer likewise contains no Qoder bearer provisioning step.

The design document explicitly claimed that the installer documents this command, but the archived implementation does not.

Verdict:

```text
LAUNCHD_QODER_TOKEN_RUNTIME_LOOKUP=PASS
QODER_BEARER_KEYCHAIN_PROVISIONING=FAIL/PARTIAL
FRESH_MAC_QODER_REPRODUCIBILITY=NOT_CLOSED
```

---

# 9. Additional protocol-control defects

## 9.1 Codex `parallel_tool_calls` is silently ignored

The Chat endpoint stores `parallel_tool_calls` in `RouterRequest`, but the Codex adapter has no representation or rejection for it. The provider sees nothing.

The design promised `PASS_OR_EXPLICIT_PROVIDER_REJECTION`; current behavior is neither.

The Responses endpoint has no Codex-specific `tool_choice`/parallel rejection at all, so the behavior differs between `/v1/chat/completions` and `/v1/responses`.

```text
CODEX_PARALLEL_TOOL_POLICY=Silently_DROPPED
CODEX_RESPONSES_FORCED_TOOL_CHOICE_POLICY=INCONSISTENT
```

Once `dynamicTools` is implemented, unsupported tool-selection constraints should fail closed consistently on both HTTP surfaces unless a faithful mapping exists.

## 9.2 Documentation overclaims

Examples:

- design says providers use the shared broker; production does not;
- design says `cmm_session_id` correlation transport exists; production has no such field;
- design says Claude adapter passes `mcpServers` and resumes the session; it does not;
- design says Router registers Antigravity MCP bridge; it does not;
- evidence says `TOOL_CHOICE_PRESERVED=PASS`; actual Command Code client drops the fields;
- evidence says `RESPONSES_STREAMING_TOOL_SEMANTICS=PASS`; no such proof exists;
- evidence reports `FINAL_HEAD=a259b9c...`, while the actual audited archive is `b891af3...` including the evidence commit itself.

The last item is documentary only; the others correspond to functional gaps.

---

# 10. What genuinely passed in this implementation pass

The following work should be preserved rather than rewritten:

```text
REGRESSION_BASELINE=STRONG
PAYG_POISON_GUARDS=PASS
LOOPBACK_BASELINE=PASS
CMMCHAT_CHAT_ONLY_BOUNDARY=PASS
COMMAND_CODE_OPENAI_ASSISTANT_TOOL_HISTORY=PASS
COMMAND_CODE_OPENAI_FRAGMENT_INDEX_CORRELATION=PASS
RESPONSES_FUNCTION_CALL_OUTPUT_INPUT_PARSE=PASS
CODEX_ORIGINAL_SERVER_REQUEST_CONTINUATION=PASS_DETERMINISTIC
CODEX_SUCCESS_TRUE_WITH_QODER_RESULT=PASS_DETERMINISTIC
CODEX_SAME_THREAD_TURN_DRAIN=PASS_DETERMINISTIC
LAUNCHD_QODER_TOKEN_LOOKUP=PASS
BROKER_CORE_UNIT_BEHAVIOR=PASS_ISOLATED
```

This is useful progress. The failure is concentrated in **production integration and protocol truth**, not broad Router instability.

---

# 11. Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_COMPLETION_REAUDIT=FAIL

AUDITED_HEAD=b891af36a02e88a02151d845abf83f64c2e3d051
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=e6f471a7f8243f1daf6cc197463b8fb06099cd2aec9aad91276da674522b8d5b
LOG_SHA256=99805a1f3c16aab5530b5a26cd6acc2d94cf7e01fb0eb97d0bc84bfe09bb72a5
LATE_CLAUDE_PATCH_INCLUDED=NO
REGRESSION_SIGNAL=STRONG

CMMCHAT_CHAT_ONLY=PASS
QODER_CONSUMER_AUTH_BOUNDARY=PASS

DEFERRED_TOOL_BROKER_CORE=PASS_ISOLATED
DEFERRED_TOOL_BROKER_PRODUCTION_WIRING=FAIL
BROKER_BOUND_PRODUCTION_PENDING_STATE=FAIL
BROKER_TTL_PRODUCTION_PENDING_STATE=FAIL

CODEX_0_153_4_DYNAMIC_TOOLS_AVAILABLE=YES_EXPERIMENTAL
CODEX_EXPERIMENTAL_API_OPT_IN=FAIL
CODEX_QODER_TOOL_DEFINITION_DECLARATION=FAIL
CODEX_NO_DECLARATION_CHANNEL_BLOCKER=FALSE
CODEX_SAME_TURN_CONTINUATION=PASS_DETERMINISTIC
CODEX_PENDING_CORRELATION=FAIL
CODEX_PENDING_TTL=FAIL
CODEX_MISSING_CALL_ID_FAIL_CLOSED=FAIL
CODEX_CHAT_AND_TOOLS=FAIL

COMMAND_CODE_OPENAI_ASSISTANT_TOOL_HISTORY=PASS
COMMAND_CODE_OPENAI_FRAGMENTED_STREAM=PASS
COMMAND_CODE_TOOL_CHOICE_UPSTREAM=FAIL
COMMAND_CODE_PARALLEL_TOOL_POLICY_UPSTREAM=FAIL
COMMAND_CODE_ANTHROPIC_TOOL_WIRE=NOT_IMPLEMENTED
COMMAND_CODE_ANTHROPIC_NO_TOOL_CHANNEL_CLAIM=NOT_PROVEN
COMMAND_CODE_STAR_REQUIREMENT=FAIL

CLAUDE_DEFER_HELPERS=PASS_ISOLATED
CLAUDE_ADAPTER_DEFER_MCP_WIRING=FAIL
CLAUDE_SAME_SESSION_RESUME_IMPLEMENTED=NO
CLAUDE_CHAT_AND_TOOLS=FAIL

ANTIGRAVITY_MCP_HELPERS=PASS_ISOLATED
ANTIGRAVITY_ADAPTER_MCP_WIRING=FAIL
ANTIGRAVITY_PENDING_TOOL_CONTINUATION=NO
GOOGLE_CHAT_AND_TOOLS=FAIL

RESPONSES_FUNCTION_CALL_OUTPUT_INPUT=PASS
RESPONSES_FUNCTION_CALL_CALL_ID_OUTPUT=FAIL
RESPONSES_STREAMING_TOOL_SEMANTICS=FAIL

LAUNCHD_QODER_TOKEN_LOOKUP=PASS
QODER_BEARER_PROVISIONING=FAIL_PARTIAL

BROKER_UNIT_CANCELLATION=PASS
PRODUCTION_TOOL_BOUNDARY_CANCELLATION=NOT_PROVEN
PRODUCTION_TOOL_ISOLATION=NOT_PROVEN
TOOL_RESULT_SIZE_BOUND=NOT_PROVEN

API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
LIVE_TOOL_ACCEPTANCE_RUN=NO
LIVE_TOOL_ACCEPTANCE_AUTHORIZED=NO

TASK13_QODER_REQUIREMENT=NOT_MET
FINAL_CLOSURE_ELIGIBLE=NO
NEXT=TASK13_PROTOCOL_TRUTH_AND_PRODUCTION_WIRING_PASS
```

---

# 12. Required next implementation pass

Do **not** reopen the older Router remediations. The next pass should be narrow and should not introduce another abstract broker redesign.

## A. Codex — use the real 0.153.4 experimental API

- opt into `experimentalApi` during initialize;
- generate experimental schema fixtures with `--experimental`;
- add `dynamicTools` to schema-backed thread-start types;
- map Qoder tools into `DynamicToolSpec` and send them on `thread/start`;
- preserve the already-good same-turn `item/tool/call` continuation;
- replace the raw `pendingTools` map with the real bounded broker;
- reject missing `callId`/tool as protocol errors;
- add strict declaration + duplicate-call/cross-thread/TTL integration tests.

## B. Shared broker — actually connect it to provider/HTTP production state

- instantiate one production broker in the composition root or inject one into adapters that need cross-request pending state;
- use composite keys, not call-id-only maps;
- wire cancel/disconnect/provider-death cleanup;
- prove max bound and TTL through real provider paths;
- decide the correlation transport that Qoder can actually echo. If `cmm_session_id` is retained, prove Qoder round-trips it; otherwise use a different strong correlation design and document it.

## C. Command Code

- extend `CommandCodeClient.streamChatCompletion()` options/body to actually serialize `tool_choice` and `parallel_tool_calls`;
- add a strict upstream-body test against the concrete client;
- implement Anthropic Messages client tools (`tools`, `tool_use`, `input_json_delta`, `tool_result`) rather than assuming `/messages` has no tool channel;
- keep GOAT/on-demand spend gates unchanged.

## D. Claude

- wire the bridge into `ClaudeAdapter.run()`;
- configure an actual external stdio MCP server in `Options.mcpServers`;
- attach `PreToolUse: defer` only to Qoder bridge tools;
- surface real `deferred_tool_use`;
- broker the result;
- resume the exact session;
- then and only then authorize one minimal live subscription-backed defer/resume test.

## E. Antigravity

- implement a real bridge process/configuration lifecycle;
- wire it into the Antigravity adapter and broker;
- deny native mutation tools;
- prove pending MCP call survives Qoder's split HTTP boundary deterministically where possible;
- then authorize the minimal live headless MCP proof if still necessary.

## F. Responses + runtime completeness

- emit canonical `call_id` distinct from item `id`;
- implement function-call streaming item lifecycle and final arguments event;
- add real Responses streaming tests;
- provision `qoder-bearer` in installation docs/scripts;
- replace vacuous size/malformed/logging tests with integrated provider/HTTP tests.

Only after an independent reaudit of that pass should any live tool acceptance be run.
