# Task 13 — Protocol Truth & Production Wiring: Evidence

**Date:** 2026-09-10
**Status:** `IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT`
**Start HEAD:** `da70e9e522001ef28f20e89c06414bd21363c26f`
**Design:** `docs/superpowers/specs/2026-09-10-task13-protocol-truth-production-wiring-design.md`
**Plan:** `docs/superpowers/plans/2026-09-10-task13-protocol-truth-production-wiring-plan.md`

This document reports the *actual* state of this pass. It does not rewrite any
historical audit. Where a family is not finished it says so.

---

## 1. Installed provider interfaces (re-verified this session)

```text
codex-cli 0.153.4
agy 1.1.28
@anthropic-ai/claude-agent-sdk 0.3.266
```

---

## 2. P0 #1 — Codex 0.153.4 experimental dynamic tools

### 2.1 The previous blocker was false (proven)

Generated in a temp directory (never overwriting tracked fixtures):

```bash
codex app-server generate-json-schema --experimental \
  --out /tmp/cmm-codex-schema-experimental-0.153.4
```

Findings taken from the generated artifacts, not prose:

- `v2/ThreadStartParams.json` exposes
  `dynamicTools: { default: null, type: ["array","null"], items: {$ref: "#/definitions/DynamicToolSpec"} }`.
- `definitions/DynamicToolSpec` = `oneOf[FunctionDynamicToolSpec, NamespaceDynamicToolSpec]`.
  `FunctionDynamicToolSpec` requires `description, inputSchema, name, type="function"`
  and allows `deferLoading: boolean`.
- `v1/InitializeParams.json` → `capabilities?: InitializeCapabilities|null` with
  `experimentalApi: boolean (default false)`.
- `DynamicToolCallParams` requires `arguments, callId, threadId, tool, turnId`
  (so a missing `callId` is a protocol violation, not a synthesizable field).
- `DynamicToolCallResponse` requires `contentItems, success`.

Tracked separately, never mixed with the stable fixture set:

```text
tests/fixtures/generated/codex-experimental-0.153.4/
  ThreadStartParams.dynamicTools.json
  DynamicToolSpec.json
  DynamicToolNamespaceTool.json
  InitializeCapabilities.json
  DynamicToolCallParams.json
  DynamicToolCallResponse.json
  DynamicToolCallOutputContentItem.json
  PROVENANCE.json
```

### 2.2 What was implemented

- `buildCodexInitializeParams()` sends `capabilities: { experimentalApi: true }`
  on the real initialize handshake (both the spawned-process path and the
  injected transport path).
- `toDynamicToolSpecs()` maps Qoder/OpenAI function tools to the exact
  `FunctionDynamicToolSpec` shape (`type/name/description/inputSchema/deferLoading:false`).
  An empty tool name is refused rather than emitted.
- `thread/start` carries `dynamicTools` on the SAME thread that becomes
  tool-capable; text-only turns send no `dynamicTools` field at all.
- Fail closed on `item/tool/call` missing `callId`, `tool`, `threadId`, `turnId`,
  or `arguments`: the original wire request is answered `success:false` and the
  run yields `provider_protocol_error`. No fabricated call id.

Deterministic proof (`tests/providers/codex-dynamic-tool-declaration.test.ts`,
using a strict fake app-server that refuses `thread/start` without a valid
declaration and that refuses to synthesize any tool call until it observed one):

```text
CODEX_DYNAMIC_TOOLS_SCHEMA_TRACKED=PASS
CODEX_EXPERIMENTAL_API_OPT_IN=PASS
CODEX_DYNAMIC_TOOLS_SENT=PASS
CODEX_QODER_TOOL_DEFINITIONS_SENT=PASS
CODEX_STRICT_DECLARATION_E2E=PASS
CODEX_MISSING_CALL_ID_FAIL_CLOSED=PASS
CODEX_MISSING_TOOL_NAME_FAIL_CLOSED=PASS
CODEX_PROVIDER_CALL_ID_FABRICATION=NONE
```

Preserved same-turn continuation (`tests/providers/codex-same-turn-continuation.test.ts`):

```text
CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED=YES
CODEX_DYNAMIC_TOOL_RESPONSE_SUCCESS_TRUE=YES
CODEX_SAME_THREAD_CONTINUATION=YES
CODEX_SAME_TURN_CONTINUATION=YES
CODEX_NEW_THREAD_FOR_TOOL_RESULT=NO
CODEX_TOOL_RESULT_STRINGIFIED_AS_FAKE_HISTORY=NO
```

---

## 3. P0 #2 — Broker is production state

- One `DeferredToolBroker` is created in `createProductionRegistry()` and
  injected into the Codex adapter (`src/index.ts`). The adapter no longer keeps
  its own `callId`-keyed unbounded `pendingTools` map.
- **Public vs provider-internal identity.** The Router issues a globally unique
  public id (`cmm_<provider>_<uuid>`) to the consumer and stores a lossless
  mapping to `{provider, providerSession, providerTurn, providerCallId, wireRequestId}`.
  Qoder returns only the public id (its standard OpenAI follow-up carries just
  `tool_call_id`); the provider's own `callId` is retained internally and used
  when answering the original wire request. No non-standard correlation field is
  assumed to be echoed.
- Bounded (`maxPending` 64), TTL-limited (120 s), one-shot, cancellable,
  duplicate/late-safe. No tool argument or result content is retained.
- A tool result that matches no parked call now fails closed instead of opening
  a fresh provider thread.

Deterministic proof through the real adapter + broker
(`tests/providers/codex-broker-adversarial.test.ts`):

```text
DUPLICATE_PROVIDER_CALL_ID_ISOLATION=PASS   (same provider callId, two live sessions)
BROKER_CROSS_REQUEST_ISOLATION=PASS
GUESSED_TOOL_ID_REJECTED=PASS
NO_NEW_THREAD_FOR_UNKNOWN_TOOL_RESULT=PASS
BROKER_PENDING_BOUND=PASS
BROKER_TTL=PASS
PRODUCTION_DUPLICATE_RESULT_REJECTED=PASS
PRODUCTION_LATE_RESULT_REJECTED=PASS
BROKER_PROVIDER_DEATH_CLEANUP=PASS
PRODUCTION_CROSS_RUN_CANCEL_ISOLATION=PASS
```

---

## 4. Command Code — both wires

### 4.1 OpenAI wire (fixed)

`CommandCodeClient.streamChatCompletion()` now serializes `tool_choice` and
`parallel_tool_calls` into the concrete HTTP JSON body; the adapter passes the
option names the client reads. Strict test inspects the **emitted body**
(`tests/providers/command-code-openai-body.test.ts`):

```text
COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY=PASS
COMMAND_CODE_OPENAI_PARALLEL_TOOL_CALLS_HTTP_BODY=PASS
SILENT_TOOL_CHOICE_DROP=NONE
SILENT_PARALLEL_TOOL_POLICY_DROP=NONE
```

Preserved: assistant `tool_calls` history, exact `tool_call_id`, upstream
`index`-based fragment correlation, GOAT spend protection.

### 4.2 Anthropic wire (implemented)

`/provider/v1/messages` follows the Anthropic Messages schema, which natively
supports client-defined tools. Implemented: `tools[]` declaration,
`content_block_start` (`tool_use`) + `input_json_delta` streaming →
Router tool calls, and `tool_result` continuation with the exact `tool_use_id`.
Malformed complete arguments fail closed before any upstream request.
Anthropic-wire models are now advertised `CHAT_AND_TOOLS`
(`tests/providers/command-code-anthropic-tools.test.ts`):

```text
COMMAND_CODE_ANTHROPIC_TOOL_DECLARATION=PASS
COMMAND_CODE_ANTHROPIC_TOOL_USE_PARSE=PASS
COMMAND_CODE_ANTHROPIC_STREAMING_ARGUMENTS=PASS
COMMAND_CODE_ANTHROPIC_TOOL_RESULT_CONTINUATION=PASS
COMMAND_CODE_ANTHROPIC_CHAT_AND_TOOLS=PASS
COMMAND_CODE_NATIVE_TOOL_EXECUTION=NONE
```

---

## 5. Responses function-call lifecycle

- Non-streaming `function_call` output now carries **both** the output item id
  (`fc_<callId>`) and the `call_id` used for `function_call_output`. The prior
  false-positive test that accepted `call_id ?? id` was replaced with exact-key
  assertions.
- Streaming emits the canonical lifecycle with `output_index`, `item_id`,
  `call_id`, `name`, and assembled `arguments`:
  `response.output_item.added` → `response.function_call_arguments.delta` →
  `response.function_call_arguments.done` → `response.output_item.done` →
  `response.completed`. Text streaming is unchanged (`msg-0`).

```text
RESPONSES_FUNCTION_CALL_OUTPUT_PARSE=PASS
RESPONSES_FUNCTION_CALL_CALL_ID=PASS
RESPONSES_FUNCTION_CALL_ITEM_ID=PASS
RESPONSES_CALL_ID_DISTINCT_FROM_ITEM_ID=PASS
RESPONSES_OUTPUT_ITEM_LIFECYCLE=PASS
RESPONSES_FUNCTION_CALL_ARGUMENTS_DELTA=PASS
RESPONSES_FUNCTION_CALL_ARGUMENTS_DONE=PASS
```

---

## 6. Tool policy, result bound, malformed arguments

- Codex has no tool-selection or parallel-execution control (verified: neither
  `tool_choice` nor `parallel_tool_calls` appears anywhere in the generated
  experimental schema). `tool_choice != auto` and `parallel_tool_calls=false`
  are therefore rejected identically on `/v1/chat/completions` and
  `/v1/responses`. Command Code forwards both natively.
  (`tests/http/tool-policy-rejection.test.ts`)
- 1 MiB tool-result bound enforced at the HTTP boundary before any adapter runs;
  the framework body limit was raised to 2 MiB so the explicit policy is the
  binding constraint. `tests/http/tool-result-bound.test.ts` proves the provider
  is never reached for an oversize result (transport factory invoked 0 times).
- Malformed complete tool arguments fail closed (Anthropic wire) before contact.

```text
SILENT_TOOL_CHOICE_DROP=NONE
SILENT_PARALLEL_TOOL_POLICY_DROP=NONE
TOOL_RESULT_SIZE_BOUND_IMPLEMENTED=PASS
OVERSIZE_TOOL_RESULT_REJECTED_BEFORE_PROVIDER=PASS
MALFORMED_COMPLETE_TOOL_ARGUMENTS_FAIL_CLOSED=PASS
TOOL_ARGUMENT_LOGGING=NONE
TOOL_RESULT_LOGGING=NONE
```

---

## 7. Qoder bearer provisioning

Runtime lookup already existed (`scripts/macos/run-router.sh` reads
`service=cmm-subscription-router account=qoder-bearer`). Added: documented
intentional provisioning in `docs/macos-install.md`, an idempotent
report/reprint step in `scripts/macos/install-router.sh`, and
`tests/integration/qoder-bearer-provisioning.test.ts`.

```text
QODER_BEARER_RUNTIME_LOOKUP=PASS
QODER_BEARER_PROVISIONING=PASS
QODER_BEARER_NO_TRACKED_SECRET=PASS
QODER_FRESH_MAC_REPRODUCIBILITY=PASS
```

---

## 8. P0 #3/#4 — Claude and Antigravity: FOUNDATION ONLY, NOT WIRED

**This is the principal incomplete area of this pass.**

SDK inspection (0.3.266) established:

- `Options.mcpServers` accepts an explicit external stdio server
  (`McpStdioServerConfig {type:'stdio', command, args, env, timeout?, alwaysLoad?}`),
  so a real external MCP bridge process is configurable.
- `SDKResultSuccess.deferred_tool_use` and `TerminalReason 'tool_deferred'` exist,
  but there is **no SDK API to feed a deferred tool's result back**. The CLI owns
  the loop, so `PreToolUse: defer` → resume is not a supported round-trip in this
  SDK version.
- The protocol-correct architecture is therefore B: keep one SDK query alive while
  the external MCP handler parks the `tools/call`, surface the call to Qoder, then
  release the handler with Qoder's result and keep draining the same query.

Delivered (verified):

- `src/bridge/control-ipc.ts` — Router-facing Unix-socket control channel:
  per-session `0700` directory, `0600` socket, 32-byte unguessable per-session
  token required on the first frame, Unix-socket only (no network bind),
  directory + socket removed on close, arguments/results never logged.
- `src/bridge/mcp-bridge-process.ts` — provider-facing external stdio MCP server
  that parks `tools/call` over the control channel and returns only the
  Router-supplied result. It performs no filesystem, shell, or edit side effect.

```text
CLAUDE_BRIDGE_CONTROL_IPC=PASS
BRIDGE_CONTROL_TOKEN_REQUIRED=PASS
BRIDGE_CONTROL_CLEANUP=PASS
BRIDGE_CONTROL_SOCKET_HARDENED=PASS
BRIDGE_CONTROL_UNIX_SOCKET_ONLY=PASS
CLAUDE_EXTERNAL_BRIDGE_PROCESS=PASS
CLAUDE_TOOL_DECLARATION=PASS
CLAUDE_QODER_RESULT_CORRELATED=PASS
CLAUDE_NATIVE_TOOL_EXECUTION=NONE
```

**Not delivered:** `ClaudeAdapter.run()` is not yet wired to configure
`mcpServers`, to race the SDK stream against the parked bridge request, or to
resume the same logical session on the follow-up HTTP request.
`AntigravityAdapter` is not wired at all.

Consequently, truthfully:

```text
CLAUDE_ADAPTER_MCP_WIRING=FAIL
CLAUDE_QODER_TOOL_CALL_SURFACED=PASS (bridge level) / NOT_WIRED (adapter level)
CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION=FAIL
CLAUDE_QODER_CAPABILITY=CHAT_ONLY_BLOCKED
ANTIGRAVITY_ADAPTER_MCP_WIRING=FAIL
ANTIGRAVITY_QODER_CAPABILITY=CHAT_ONLY_BLOCKED
GOOGLE_QODER_CAPABILITY=FAIL
```

The remaining work is bounded and specified: a per-request
`BridgeControlServer` + spawned bridge process owned by each adapter, a
`Map<publicToolCallId, {query iterator, control server, scope}>` with TTL/bound,
a race between SDK messages and `onToolCall`, and cleanup on
cancel/disconnect/provider death. This is a state-machine change to two large
adapters (~540 and ~911 lines) and was not completed in this pass.

No live provider inference was run.

---

## 9. Regression protection and gate

Preserved: reaudit-6 protocol fixes, Codex malformed-frame/notification/cancel
isolation, preflight/schema equivalence, launchd fail-closed, Claude profile/env
isolation, Command Code abort/timeout protection, PAYG poison guards, loopback
binding, consumer capability policy, CMMChat CHAT_ONLY, logging hygiene.

Final gate (this pass, working tree at the commits below):

```text
TEST_RUN_1_RC=0     (481 passed, 25 skipped)
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
TASK13_NEW_SUITES=11 files / 32 tests, all passing (run explicitly by path)
LIVE_TOOL_ACCEPTANCE_RUN=NO
```

The 25 skips are the pre-existing live-gated integration suites
(`claude.integration`, `antigravity.integration`, `codex.integration`,
`command-code.integration`, `tool-roundtrip.integration`) plus one
`codex-mutation-canary` case. No deterministic Task 13 production-wiring test is
skipped.

---

## 10. Commits (this pass, on top of `da70e9e`)

```text
b27c1dd docs: design Task 13 protocol truth production wiring
c5ec204 docs: plan Task 13 protocol truth production wiring
2ae5df0 test: expose Codex experimental dynamicTools gap
3a2459d feat: enable Codex experimental dynamic tools and production broker
52a6ff9 test: prove production broker correlation and cleanup
b0822fd fix: forward Command Code OpenAI tool controls
6527076 feat: implement Command Code Anthropic tool wire
2065702 fix: complete Responses function-call lifecycle and bound tool results
1ae0c0a fix: reject unrepresentable Codex tool constraints on both surfaces
7df6007 fix: complete Qoder bearer provisioning for a fresh Mac
38792b6 feat: add secure external MCP bridge control transport
4b84065 security: harden production Qoder tool ownership invariants
23cdbd8 test: make bridge-control tests poll instead of fixed sleeps
```

---

## 11. Known limitations

1. Claude and Antigravity adapters are not wired; both remain `CHAT_ONLY_BLOCKED`
   for the Qoder consumer. GLOBAL Task 13 is therefore **not** PASS.
2. The cancellation matrix is proven for the Codex production path and the broker
   core; the equivalent matrix for Claude/Antigravity is not applicable until
   those adapters are wired.
3. Codex experimental APIs are version-pinned to 0.153.4; the tracked fixture and
   provenance record the exact command and version.
4. No live provider inference was performed in this phase
   (`LIVE_TOOL_ACCEPTANCE_RUN=NO`).
