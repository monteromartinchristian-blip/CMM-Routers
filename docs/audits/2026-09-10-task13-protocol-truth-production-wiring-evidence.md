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

The sentinel-secret logging proof runs through the real HTTP -> Claude adapter
-> broker -> external bridge path; unmatched sentinels in tool arguments and the
tool result are absent from every captured stdout/stderr write.

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

## 8. P0 #3/#4 — Claude and Antigravity are wired through the real adapters

### 8.1 SDK/CLI facts that drove the architecture

- `Options.mcpServers` accepts an explicit external stdio server
  (`McpStdioServerConfig`), so a real external MCP bridge process is configurable.
- `SDKResultSuccess.deferred_tool_use` and `TerminalReason 'tool_deferred'` exist,
  but there is **no SDK API to feed a deferred tool result back**. Architecture A
  (defer + resume) is therefore not a supported round-trip in 0.3.266.
- Chosen architecture B: keep one provider run alive while the external MCP
  handler parks the `tools/call`, surface the call to Qoder, then release the
  handler with Qoder's result and keep draining the SAME run.
- `agy 1.1.28` supports MCP servers (`agy mcp add|remove|list|enable|disable`,
  `--env KEY=value`, `--type stdio`), so Antigravity MCP tools run CLI-side and
  the same bridge architecture applies.

### 8.2 Shared bridge-control IPC

`src/bridge/control-ipc.ts` — Router-facing Unix-socket control channel:
per-session `0700` directory, `0600` socket, 32-byte unguessable per-session
token required on the first frame, Unix-socket only (no network bind), directory
and socket removed on close, arguments/results never logged.

`src/bridge/mcp-bridge-process.ts` — provider-facing external stdio MCP server
that parks `tools/call` over the control channel and returns only the
Router-supplied result. It performs no filesystem, shell, or edit side effect.

```text
CLAUDE_BRIDGE_CONTROL_IPC=PASS
BRIDGE_CONTROL_TOKEN_REQUIRED=PASS
BRIDGE_CONTROL_CLEANUP=PASS
BRIDGE_CONTROL_SOCKET_HARDENED=PASS
BRIDGE_CONTROL_UNIX_SOCKET_ONLY=PASS
CLAUDE_EXTERNAL_BRIDGE_PROCESS=PASS
```

### 8.3 Claude

`ClaudeAdapter.run()` configures `mcpServers.cmm_qoder` with only the caller's
tools (`allowedTools: mcp__cmm_qoder__*`), then races SDK messages against
parked bridge requests through the shared broker's public id. A tool call keeps
the SDK query alive and ends the exchange with `finishReason: "tool_calls"`; the
follow-up request resolves the bridge over the control IPC and continues the
SAME query. Claude's native shell/file/edit tools stay disabled.

`tests/providers/claude-bridge-roundtrip.test.ts` drives the real adapter, a real
spawned bridge process, and the real control channel:

```text
CLAUDE_ADAPTER_MCP_WIRING=PASS
CLAUDE_TOOL_DECLARATION=PASS
CLAUDE_EXTERNAL_BRIDGE_PROCESS=PASS
CLAUDE_BRIDGE_CONTROL_IPC=PASS
CLAUDE_QODER_TOOL_CALL_SURFACED=PASS
CLAUDE_QODER_RESULT_CORRELATED=PASS
CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION=PASS
CLAUDE_NATIVE_TOOL_EXECUTION=NONE
CLAUDE_UNMATCHED_TOOL_RESULT_FAIL_CLOSED=PASS
```

### 8.4 Antigravity

One CMM-owned MCP server (`cmm-qoder-tools`) is registered lazily and
idempotently — once per adapter, never per request — pointing at
`src/bridge/mcp-bridge-launcher.ts`. The registration carries **no secrets**:
the per-session socket and token live in a user-only (`0600`) rendezvous file
that the launcher discovers at startup, failing closed when zero or more than
one live session exists. `AntigravityAdapter.run()` then races agy stream events
against parked bridge calls; the agy process stays alive across the split HTTP
interaction and the follow-up continues the SAME run. `--dangerously-skip-permissions`
and agy's native `run_command`/`replace_file_content`/`write_to_file` are never
used for Qoder-owned tools.

`tests/providers/antigravity-bridge-roundtrip.test.ts` drives the real adapter
with a fake agy that speaks the observable protocol and acts as the MCP client:

```text
ANTIGRAVITY_ADAPTER_MCP_WIRING=PASS
ANTIGRAVITY_EXTERNAL_BRIDGE_PROCESS=PASS
ANTIGRAVITY_MCP_TOOL_REQUEST_RECEIVED=PASS
ANTIGRAVITY_QODER_TOOL_CALL_SURFACED=PASS
ANTIGRAVITY_QODER_RESULT_CORRELATED=PASS
ANTIGRAVITY_SAME_RUN_CONTINUATION=PASS
ANTIGRAVITY_NATIVE_FILESYSTEM_EXECUTION=NONE
ANTIGRAVITY_NATIVE_SHELL_EXECUTION=NONE
MCP_REGISTRATION_SECRET_FREE=PASS
BRIDGE_SESSION_RENDEZVOUS_HARDENED=PASS
```

### 8.5 Truthful residual limitation

The only unverified step for Antigravity is that the **installed `agy` CLI
actually invokes registered MCP tools during a headless `--print` run**. Every
Router-side component is deterministic and proven above, but that single
provider-side behaviour cannot be established without a model turn. The exact
single probe required (NOT run in this phase, per the live-test policy):

```bash
# after: agy mcp add ... cmm-qoder-tools  (registered by the adapter)
agy --print "use the cmm_echo tool with text=canary" --output-format stream-json \
  --model <slug> --mode plan --sandbox
# expected: an MCP tools/call reaches the Router control channel
```

No live provider inference was run.

## 9. Regression protection and gate

Preserved: reaudit-6 protocol fixes, Codex malformed-frame/notification/cancel
isolation, preflight/schema equivalence, launchd fail-closed, Claude profile/env
isolation, Command Code abort/timeout protection, PAYG poison guards, loopback
binding, consumer capability policy, CMMChat CHAT_ONLY, logging hygiene.

Final gate (this pass, working tree at the commits below):

```text
TEST_RUN_1_RC=0     (485 passed, 25 skipped, 98 files)
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0  (23 PASS markers)
TASK13_NEW_SUITES=14 files / 37 tests, all passing (run explicitly by path)
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
309f279 docs: add Task 13 protocol truth production wiring evidence
8f7e70a feat: wire Claude Qoder tool bridge into the adapter
e6e3384 feat: wire Antigravity Qoder tool bridge into the adapter
897edf9 docs: finalize Task 13 evidence and audit for the completed pass
58ff6ae test: prove the Router-level production path and drop vacuous tests
```

### 10.1 Router-level production proof

`tests/http/tool-roundtrip-production.test.ts` traverses the complete
production path over HTTP — capability boundary, the production `ClaudeAdapter`,
the shared `DeferredToolBroker`, a real spawned external MCP bridge process and
the control IPC — then accepts Qoder's simulated result and continues the SAME
session to the final HTTP response:

```text
HTTP_ROUNDTRIP_QODER_TOOL_CALL_SURFACED=PASS
HTTP_ROUNDTRIP_QODER_RESULT_CORRELATED=PASS
HTTP_ROUNDTRIP_SAME_SESSION_CONTINUATION=PASS
QODER_EXECUTION_OWNER=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
```

The two tests the reaudit identified as vacuous (a bare `JSON.parse` throw and a
local `"x".repeat(...)` length check) were replaced with real assertions against
the production guard (`assertToolResultsWithinBound`) and the real producer
(`buildAnthropicRequestBody`).

### 10.2 Parked-session lifetime

A parked session is bounded by a finite `SESSION_TTL_MS` (120 s, matching the
broker entry bound) so a continuation that never arrives cannot leak the live
provider run, the bridge process, or the control socket. `cancel()` deliberately
does **not** tear down a parked session: the HTTP layer closes the reply socket
after the `tool_calls` response, which is indistinguishable from a genuine
cancel at that layer, and killing the session there would break the legitimate
cross-request round-trip.

## 11. Known limitations

1. Antigravity's provider-side behaviour (that the installed `agy` invokes
   registered MCP tools during a headless `--print` run) is unverified without a
   model turn. The exact single probe is documented in §8.5 and was not run.
2. The MCP bridge supports one parked call per live session. A second concurrent
   `tools/call` on the same session is refused with a protocol error rather than
   silently dropped; parallel tool calls within a single provider turn are not
   modelled.
3. Codex experimental APIs are version-pinned to 0.153.4; the tracked fixture and
   provenance record the exact command and version.
4. The production cancellation matrix is proven for the Codex production path and
   the broker core, plus session release on cancel for Claude and Antigravity.
   Exhaustive per-scenario HTTP-level matrices for the two MCP providers are not
   separately enumerated.
5. No live provider inference was performed in this phase
   (`LIVE_TOOL_ACCEPTANCE_RUN=NO`).
