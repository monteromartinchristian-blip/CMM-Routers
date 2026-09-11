# CMM Subscription Router — Independent Task 13 Re-audit

**Date:** 2026-09-10
**Audited HEAD:** `0ffc145545c79f1ac4869a2c5fbf7c1d7eef7a84`
**Scope:** Task 13 — Qoder Tool Calling / Provider-Owned Reasoning, Qoder-Owned Tools
**Verdict:** **FAIL**

## 0. Integrity and regression signal

Independent artifact verification:

```text
ARCHIVE_COMMIT=0ffc145545c79f1ac4869a2c5fbf7c1d7eef7a84
BUNDLE_SHA256=cce9d81bec5e4149abd7d968907f1e7c5f71f5fc838d1d6268f096fa66b69525
LOG_SHA256=b29f23116f34274735537394c3e6cadfde1cf3b4e82fdb30ec71e9b2f236f966
GZIP_TEST=PASS
WORKTREE_CAPTURE=CLEAN
```

The supplied verification log is a strong regression signal:

```text
TEST_RUN_1_RC=0
TEST_RUN_2_RC=0
TEST_RUN_3_RC=0
TYPECHECK_RC=0
BUILD_RC=0
POST_BUILD_TEST_RC=0
SECURITY_AUDIT_RC=0
TARGETED_TOOL_CAPABILITY_RC=0
TARGETED_CODEX_RC=0
TARGETED_COMMAND_CODE_RC=0
TARGETED_CLAUDE_RC=0
TARGETED_ANTIGRAVITY_RC=0
OPENAI_PAYG_POISON_RC=1
ANTHROPIC_PAYG_POISON_RC=1
GOOGLE_PAYG_POISON_RC=1
```

This means the Task 13 delta did not broadly destabilize the already-audited router. It does **not** establish that the new provider-specific tool loops are wire-correct. Static inspection of the exact archive finds multiple false-positive E2Es and incomplete production wiring.

---

# 1. P0 — Codex is incorrectly advertised as `CHAT_AND_TOOLS`

## 1.1 Qoder tool definitions are never sent into Codex

Production `src/providers/codex/adapter.ts` only inspects:

```ts
const toolDefinitionsRequested = request.tools.length > 0;
```

but does not translate `request.tools` into any app-server request, thread/turn configuration, dynamic-tool registration, MCP bridge, or other Codex-visible schema. The `thread/start` call at lines ~187–195 contains model, sandbox, developer instructions and `ephemeral:true`, but no tool definitions.

A repository-wide production search confirms that the Task 13 Codex path contains no actual mapping from `RouterTool[]` into Codex's dynamic-tool protocol.

Therefore a real model cannot discover arbitrary Qoder-supplied tools merely because Qoder included them in the OpenAI request.

### False-positive test

`tests/providers/codex-tool-e2e.test.ts` scripts the fake app-server to emit `item/tool/call` unconditionally on the first turn. The fake server never requires evidence that `cmm_echo` was actually declared to Codex.

More seriously, `tests/providers/codex-dynamic-tool.test.ts:109` prints:

```text
CODEX_EXTERNAL_TOOL_DEFINITION_SENT=YES
```

inside a test that only injects a synthetic `item/tool/call` into the client and tests the response shape. It sends **no tool definition at all**. This marker is factually unsupported by the test.

Verdict:

```text
CODEX_EXTERNAL_TOOL_DEFINITION_SENT=NO
CODEX_TOOL_DISCOVERY_WIRE=FAIL
CODEX_TOOL_E2E=FALSE_POSITIVE
```

## 1.2 `success:false` breaks the native dynamic-tool continuation

When Codex sends `item/tool/call`, production currently does:

```ts
this.client.respondToServerRequest(wireRequestId, {
  success: false,
  contentItems: [{
    type: "inputText",
    text: "Tool execution owned by the consumer (Qoder); result delivered on the follow-up turn."
  }],
});
```

The tracked Codex 0.153.4 generated schema labels `item/tool/call` as a server request to **execute a dynamic tool call on the client**, and `DynamicToolCallResponse` has `{success, contentItems}`. The protocol is bidirectional precisely so the client can answer that pending request.

The current implementation tells Codex that the tool failed, closes that tool request, ends the Router HTTP request, and later starts a **new ephemeral Codex thread** for Qoder's follow-up.

That is not the same dynamic tool call being completed.

## 1.3 The follow-up is textual reconstruction, not native tool history

`buildCodexThreadSeeds()`:

- ignores `assistant.toolCalls` entirely when assistant `content` is null;
- turns a Qoder tool result into user text such as `[tool_result call_id] value`;
- starts a new ephemeral thread for the second Router request.

Thus `CODEX_TOOL_RESULT_REINJECTED=YES` in the current test means “the scripted second fake turn returned a final answer after a textual history reconstruction,” not “the original Codex dynamic tool request received Qoder's result.”

The tracked 0.153.4 schema also exposes native tool-output semantics (`DynamicToolCallResponse` and `TurnStartParams.toolOutput`), reinforcing that textual `[tool_result ...]` is not a proof of native continuation.

Required architecture for a genuine Qoder-owned Codex loop:

```text
Codex item/tool/call (pending JSON-RPC request)
        ↓
Router records bounded pending call + threadId + turnId + callId
        ↓
Router returns OpenAI tool_call to Qoder
        ↓
Qoder executes
        ↓
next Qoder request carries tool result
        ↓
Router matches pending call
        ↓
respond to ORIGINAL item/tool/call with success:true + Qoder output
        ↓
continue SAME Codex turn/session
```

No Codex native shell/file/edit execution is necessary for this design.

Verdict:

```text
CODEX_CHAT_AND_TOOLS=FAIL
CODEX_SAME_TOOL_CALL_CONTINUATION=FAIL
CODEX_SUCCESS_FALSE_WORKAROUND=INVALID_FOR_TRUE_ROUNDTRIP
CODEX_TOOL_RESULT_NATIVE_REINJECTION=FAIL
```

---

# 2. P0 — Command Code continuation drops the assistant tool call

The first Command Code OpenAI-wire tool call is directionally correct: `tools` are sent upstream and streamed `tool_calls` are parsed.

However, `toUpstreamMessages()` only forwards:

```ts
role
content
tool_call_id
name
```

It never serializes `RouterMessage.toolCalls` back to upstream `assistant.tool_calls`.

A standard OpenAI tool continuation requires the assistant's tool-call message followed by the tool result carrying the matching `tool_call_id`. The Router HTTP parser preserves that assistant history, but the Command Code adapter drops it before the upstream request.

### False-positive test

`tests/providers/command-code-tool-e2e.test.ts` verifies only that the second upstream body contains a `role:"tool"` message with the correct `tool_call_id`. The scripted upstream returns `final:canary` on its second call regardless of whether the preceding assistant `tool_calls` message was preserved.

Therefore the test proves neither a strict OpenAI tool continuation nor compatibility with an upstream that validates tool-call pairing.

Verdict:

```text
COMMAND_CODE_FIRST_TOOL_CALL=PASS
COMMAND_CODE_ASSISTANT_TOOL_HISTORY_FORWARDING=FAIL
COMMAND_CODE_TOOL_RESULT_CONTINUATION=NOT_PROVEN
COMMAND_CODE_CHAT_AND_TOOLS=FAIL
```

Also, the product requirement was `command-code/* -> CHAT_AND_TOOLS`; the current adapter explicitly leaves Anthropic-wire Command Code models `CHAT_ONLY`, so the provider family does not yet satisfy the clarified all-model/all-family requirement even if the OpenAI-wire defect is fixed.

---

# 3. P0/P1 — Command Code fragmented streamed tool calls are mis-correlated

`runOpenAiWire()` creates a local monotonically increasing `toolCallIndex` and ignores upstream `call.index`:

```ts
index: toolCallIndex++,
id: call.id ?? `call-${toolCallIndex}`
```

Real OpenAI-compatible streams commonly emit one logical tool call across multiple chunks. Later chunks can contain only `index` + additional function argument bytes, with no repeated `id` or `name`.

Current behavior can convert those fragments into multiple Router tool calls with synthesized IDs instead of one call with assembled arguments.

`tests/http/streaming-tool-calls.test.ts` only tests the generic HTTP aggregation layer with a provider that already emits correctly correlated `RouterEvent`s. It does not exercise the Command Code SSE parser.

Verdict:

```text
STREAMING_TOOL_ARGUMENT_ASSEMBLY=PASS_GENERIC_LAYER_ONLY
COMMAND_CODE_FRAGMENTED_TOOL_STREAM=FAIL
COMMAND_CODE_TOOL_ID_STABILITY_ACROSS_FRAGMENTS=FAIL
```

---

# 4. P1 — `tool_choice` and parallel-tool policy are discarded

Task 13 explicitly required preserving tool choice.

`RouterRequest` has no `toolChoice` or `parallelToolCalls` field. The HTTP layers inspect `tool_choice` / `parallel_tool_calls` only so they can reject them for `CHAT_ONLY`; once Qoder is allowed to use tools, these options are not stored and are not forwarded to any provider.

Verdict:

```text
TOOL_CHOICE_ROUNDTRIP=FAIL
PARALLEL_TOOL_CALL_POLICY_FORWARDING=FAIL
```

This matters for Qoder because forcing or constraining a tool is part of normal OpenAI-compatible agent control, not an optional cosmetic field.

---

# 5. P1 — `/v1/responses` tool-result input is only partially compatible

The Responses parser requires each array entry to contain a chat-style `role` (`system|user|assistant|tool`). It can parse a custom assistant content part named `function_call`, but it does not implement canonical Responses tool-result items such as `function_call_output` with `call_id` + output as first-class input items.

The project's Task 13 Responses tests therefore prove an internal chat-shaped convention, not complete compatibility with the canonical Responses function-call continuation surface.

Verdict:

```text
RESPONSES_TOOL_CALL_OUTPUT_CANONICAL_INPUT=FAIL
RESPONSES_TOOL_SEMANTICS=PARTIAL
```

---

# 6. P0 — Qoder authentication is not wired into the LaunchAgent runtime

Production reads:

```ts
process.env.CMM_QODER_TOKEN
```

but neither:

- `scripts/macos/run-router.sh`, nor
- `launchd/com.cmm.subscription-router.plist.template`

loads/provisions/exports `CMM_QODER_TOKEN`.

The launch wrapper only resolves the main Router bearer and the Command Code secret from Keychain.

Consequently the intended persistent LaunchAgent deployment does not provide the Qoder consumer token. Unless manually injected outside the supported installer/runtime flow, Qoder cannot authenticate as the tool-capable consumer at all.

Required: a separate local Keychain account (or equivalent server-owned secret source) for the Qoder bearer, loaded by `run-router.sh` without logging or persisting its value.

Verdict:

```text
QODER_AUTH_POLICY=PASS_IN_PROCESS
QODER_TOKEN_LAUNCHD_WIRING=FAIL
QODER_TOOL_RUNTIME_VIA_SUPPORTED_LAUNCHAGENT=FAIL
```

---

# 7. P1 — Tool-boundary cancellation claims are overclaimed

The Task 13 report claims:

```text
CANCEL_PRE_TOOL=PASS
CANCEL_DURING_TOOL_CALL=PASS
CANCEL_WAITING_FOR_TOOL_RESULT=PASS
CANCEL_POST_TOOL_RESULT=PASS
ACTIVE_TOOL_STATE_AFTER_CANCEL=0
```

but none of those markers/scenarios exists in the test suite.

The cited disconnect tests exercise generic hanging/text-stream providers with `tools: []`. The Codex concurrent-cancel test exercises ordinary concurrent turns, not a pending tool call split across the Qoder boundary.

Therefore generic HTTP cancellation remains well-tested, but the Task 13 cancellation matrix is not.

Verdict:

```text
GENERIC_HTTP_CANCELLATION=PASS
TOOL_BOUNDARY_CANCELLATION_MATRIX=NOT_PROVEN
CANCEL_WAITING_FOR_TOOL_RESULT=NOT_PROVEN
```

A future stateful pending-tool broker makes these tests mandatory.

---

# 8. Claude — not implemented, but the `BLOCKED` verdict is not supported

The current production Claude adapter correctly remains `CHAT_ONLY`; Task 13 did not implement Claude tools.

However, the conclusion that the installed Agent SDK cannot yield a tool call to the host is contradicted by both the captured installed type surface and Claude's documented behavior.

The verification capture itself shows the installed `@anthropic-ai/claude-agent-sdk@0.3.266` exposes:

```text
PreToolUseHookSpecificOutput
SDKDeferredToolUse
deferred_tool_use?: SDKDeferredToolUse
TerminalReason includes tool_deferred and tool_deferred_unavailable
```

Claude's current TypeScript Agent SDK reference states that when `PreToolUse` returns `permissionDecision:"defer"`, the result carries `deferred_tool_use {id,name,input}` and the host can surface that request in its own UI, then resume using the same `session_id`.

The Claude Code changelog likewise documents that headless sessions can pause at a deferred tool and resume later.

There are real caveats:

- resuming a deferred **native** tool and allowing it would let Claude execute the tool, which violates Qoder ownership;
- current SDK bug reports show in-process `createSdkMcpServer` deferred-resume issues;
- external stdio MCP has different behavior and is specifically reported to work in the defer/resume path where the in-process server does not.

Therefore the correct conclusion is not “impossible”; it is “requires a safe bridge prototype.”

A plausible Qoder-owned design is:

```text
Claude sees Qoder tool as external stdio MCP tool
        ↓
PreToolUse => defer
        ↓
SDK returns deferred_tool_use{id,name,input}; no tool side effect
        ↓
Router surfaces tool_call to Qoder
        ↓
Qoder executes
        ↓
Router stores Qoder result in bounded broker
        ↓
resume same Claude session
        ↓
MCP bridge handler only retrieves/returns the already-computed Qoder result
(no shell/filesystem/edit side effect in Claude/SDK)
        ↓
Claude continues
```

This needs a deterministic prototype before promotion to `CHAT_AND_TOOLS`.

Verdict:

```text
CLAUDE_CHAT_AND_TOOLS=NOT_IMPLEMENTED
CLAUDE_BLOCKED_VERDICT=NOT_PROVEN
CLAUDE_DEFERRED_TOOL_HOST_HANDOFF=SUPPORTED_BY_INSTALLED/DOCUMENTED_API
CLAUDE_QODER_MCP_BRIDGE=NEEDS_PROTOTYPE
```

---

# 9. Google / Antigravity — direct `stream-json` is insufficient, but `BLOCKED` is premature

The investigation correctly establishes an important negative result: the current `agy --input-format stream-json --output-format stream-json` user-input channel is not an OpenAI-style external function-call protocol. Native Antigravity tool steps are not the Qoder-owned loop we want.

`remote-control` also appears to be a browser/remote-session control daemon, not the required host-tool wire, so it is not the promising route.

But the installed CLI explicitly exposes an MCP manager, and current Antigravity documentation says the CLI supports local stdio and remote MCP servers and **custom tools**.

That leaves a concrete untested architecture analogous to Claude:

```text
Antigravity model calls custom MCP bridge tool
        ↓
bridge does not execute filesystem/shell/edit
        ↓
bridge parks request in bounded Router broker
        ↓
Router surfaces OpenAI tool_call to Qoder
        ↓
Qoder executes and submits result
        ↓
broker releases waiting MCP call with Qoder result
        ↓
Antigravity continues
```

Whether Antigravity's headless CLI can keep the MCP call/session alive across the split HTTP interaction is a prototype question. The current Task 13 implementation never tested it.

Thus:

```text
ANTIGRAVITY_STREAM_JSON_DIRECT_EXTERNAL_RESULT=UNAVAILABLE
ANTIGRAVITY_REMOTE_CONTROL=NOT_THE_REQUIRED_PROTOCOL
ANTIGRAVITY_MCP_CUSTOM_TOOL_PATH=AVAILABLE_BUT_UNPROTOTYPED
GOOGLE_CHAT_AND_TOOLS=NOT_IMPLEMENTED
GOOGLE_BLOCKED_VERDICT=NOT_PROVEN
```

---

# 10. Security assessment

The existing security/regression baseline remains strong:

```text
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
PAYG_POISON_GUARDS=PASS
CMMCHAT_TOOL_ESCALATION=NONE
UNAUTHENTICATED_TOOL_ESCALATION=NONE
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
```

However, the new Task 13 static security check is not a proof of a correct tool loop. In particular, it rewards Codex `success:false` as evidence of “provider-native tool execution blockade,” even though that same response prevents a genuine dynamic-tool continuation.

The correct security invariant is not “always reply failure.” It is:

```text
Provider may request tool
Qoder executes side effect
Router/bridge may carry already-computed result
Provider never executes Qoder filesystem/shell/edit operation
```

A `success:true` dynamic-tool response containing **Qoder's already-executed result** is compatible with Qoder ownership and should not be forbidden.

---

# 11. Documentation defects

Minor but real:

```text
Task13 report says FINAL_HEAD=0b92f8b and 9 commits.
Exact archive HEAD=0ffc145... and there are 10 Task13 commits including the report commit itself.
```

This is not a functional blocker but should be corrected in the next evidence report.

---

# 12. Independent verdict

```text
CMM_SUBSCRIPTION_ROUTER_INDEPENDENT_TASK13_REAUDIT=FAIL

AUDITED_HEAD=0ffc145545c79f1ac4869a2c5fbf7c1d7eef7a84
ARCHIVE_COMMIT_MATCH=YES
BUNDLE_SHA256=cce9d81bec5e4149abd7d968907f1e7c5f71f5fc838d1d6268f096fa66b69525
LOG_SHA256=b29f23116f34274735537394c3e6cadfde1cf3b4e82fdb30ec71e9b2f236f966
REGRESSION_SIGNAL=STRONG

CONSUMER_CAPABILITY_POLICY=PASS
CMMCHAT_CHAT_ONLY=PASS
QODER_AUTH_POLICY=PASS
QODER_LAUNCHD_TOKEN_WIRING=FAIL

OPENAI_BOUNDARY_TOOL_ID_PRESERVATION=PARTIAL_PASS
TOOL_CHOICE_FORWARDING=FAIL
PARALLEL_TOOL_POLICY_FORWARDING=FAIL
RESPONSES_CANONICAL_TOOL_OUTPUT=FAIL

CODEX_CHAT_AND_TOOLS=FAIL
CODEX_EXTERNAL_TOOL_DEFINITIONS_SENT=NO
CODEX_DYNAMIC_TOOL_SAME_CALL_CONTINUATION=FAIL
CODEX_SUCCESS_FALSE_WORKAROUND=INVALID_FOR_TRUE_ROUNDTRIP
CODEX_TOOL_E2E=FALSE_POSITIVE

COMMAND_CODE_CHAT_AND_TOOLS=FAIL
COMMAND_CODE_FIRST_TOOL_CALL=PASS
COMMAND_CODE_ASSISTANT_TOOL_HISTORY_FORWARDING=FAIL
COMMAND_CODE_FRAGMENTED_TOOL_STREAM=FAIL
COMMAND_CODE_TOOL_E2E=FALSE_POSITIVE_FOR_CONTINUATION
COMMAND_CODE_ANTHROPIC_WIRE=CHAT_ONLY_NOT_ACCEPTABLE_FOR_COMMAND_CODE_STAR_REQUIREMENT

CLAUDE_CHAT_AND_TOOLS=NOT_IMPLEMENTED
CLAUDE_BLOCKED_VERDICT=NOT_PROVEN
CLAUDE_DEFERRED_TOOL_HOST_HANDOFF=SUPPORTED
CLAUDE_EXTERNAL_MCP_BRIDGE=NEEDS_PROTOTYPE

GOOGLE_CHAT_AND_TOOLS=NOT_IMPLEMENTED
ANTIGRAVITY_STREAM_JSON_EXTERNAL_RESULT=UNAVAILABLE
ANTIGRAVITY_MCP_BRIDGE=AVAILABLE_MECHANISM_NOT_PROTOTYPED
GOOGLE_BLOCKED_VERDICT=NOT_PROVEN

GENERIC_CANCELLATION=PASS
TOOL_BOUNDARY_CANCELLATION_MATRIX=NOT_PROVEN

SECURITY_BASELINE=PASS
TASK13_TOOL_SECURITY_PROOF=PARTIAL

TASK13_QODER_REQUIREMENT=NOT_MET
LIVE_TOOL_ACCEPTANCE_AUTHORIZED=NO

NEXT=TASK13_DEFERRED_TOOL_BROKER_AND_PROVIDER_WIRE_COMPLETION
```

---

# 13. Recommended next implementation pass

Do **not** reopen the six prior Router remediations. This is a narrow Task 13 completion pass.

## A. Shared bounded deferred-tool broker

Implement a local in-memory broker keyed by at least:

```text
consumer=Qoder
provider
provider session/thread
provider turn where applicable
tool_call_id
```

Properties:

```text
TTL bounded
max entries bounded
one-shot result consumption
cancel/disconnect cleanup
provider-process-death cleanup
no content logging
no stale replay
no name-only matching
```

## B. Codex

- actually expose Qoder tool definitions to the Codex agent using the supported app-server mechanism;
- keep `item/tool/call` pending instead of replying `success:false`;
- return Qoder result into the original `DynamicToolCallResponse` with `success:true`;
- continue the same Codex thread/turn;
- prove no native command/file/edit approvals are granted.

## C. Command Code

- serialize assistant `RouterMessage.toolCalls` into upstream `tool_calls`;
- correlate streamed fragments using upstream tool-call index/id;
- forward `tool_choice` / parallel-tool policy where supported;
- add a strict mock that rejects a tool result unless the preceding assistant `tool_calls` are present;
- determine whether Anthropic-wire models can use a supported tool-capable Command Code route; otherwise the clarified `command-code/*` requirement remains unmet.

## D. Claude

Prototype `PreToolUse: defer` + same-session resume using an **external stdio MCP bridge**. The bridge must not execute the requested side effect; it only returns the result already produced by Qoder.

Fail the prototype if resume causes Claude/CLI to execute the real operation itself.

## E. Antigravity

Prototype a custom MCP bridge on `agy 1.1.28`. The MCP server must park the call, surface it through the Router to Qoder, and later return Qoder's result without performing the side effect itself.

`remote-control` does not need further pursuit unless new evidence shows an actual machine-readable host-tool API.

## F. Runtime + protocol completeness

- provision `CMM_QODER_TOKEN` through Keychain/LaunchAgent;
- preserve `tool_choice` and supported parallel-tool controls;
- implement canonical Responses `function_call_output` input;
- add the actual tool-boundary cancellation matrix.

Only after an independent audit of that pass should live tool acceptance be authorized.

---

## External references consulted

- OpenAI, *Unlocking the Codex harness: how we built the App Server* (bidirectional app-server / server request lifecycle).
- OpenAI API Reference, Chat and Responses tool semantics (`tool_choice`, tool messages, function-call output items).
- Claude Code Agent SDK TypeScript reference (`deferred_tool_use`, `tool_deferred`, same-session resume).
- Claude Code changelog (headless `PreToolUse: defer` + resume support).
- Anthropic Agent SDK issue #370 (in-process MCP defer/resume defect; external stdio MCP control works).
- Google Antigravity MCP docs (CLI supports local stdio/remote MCP and custom tools).
- Google Antigravity Remote Control docs (remote-control is remote UI/session control, not the Qoder tool-result wire).
