# CMM Subscription Router — Task 13: Qoder Tool Calling

**Date:** 2026-09-09
**Status:** IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
**START_HEAD:** `954c34892cce4f70bc7652c6b851301ce84f639b`
**FINAL_HEAD:** `0b92f8b` (9 focused commits, worktree clean)

## Product requirement (as clarified)

For the Qoder consumer, tool calling is fundamental: the model/provider
reasons, Qoder executes. The provider must never execute filesystem, shell,
code-edit, or repository-mutation tools itself. CMMChat remains intentionally
`CHAT_ONLY`. Qoder requires `CHAT_AND_TOOLS` on all four subscription-backed
provider families; a provider that cannot satisfy Qoder-owned external tool
execution through any available subscription-backed interface is reported
`FAIL/BLOCKED` with exact technical evidence — a truthful FAIL is preferred
over a fake PASS.

## 1. Consumer capability boundary

Two server-configured bearer tokens distinguish the consumers. The existing
`CMM_ROUTER_TOKEN` authenticates **CMMChat** (permanently `CHAT_ONLY` on every
provider). An optional second token `CMM_QODER_TOKEN` authenticates the
**Qoder** consumer, which may use tools only on providers whose model reports
`CHAT_AND_TOOLS`. The effective tool gate is `consumer AND provider`
(`effectiveToolCapability`): every other combination is `CHAT_ONLY`.

- Server-side and configuration-controlled; no remotely exploitable enable
  flag; identity never inferred from prompt/User-Agent/model.
- When `CMM_QODER_TOKEN` is unset there is no Qoder consumer.
- Design doc: `docs/superpowers/specs/2026-09-09-consumer-capability-policy.md`.
- Tests: `tests/http/consumer-capability.test.ts`
  `CMMCHAT_TOOLS_REJECTED=PASS`, `QODER_TOOLS_ALLOWED_WHEN_PROVIDER_CAPABLE=PASS`,
  `UNAUTHENTICATED_TOOL_ESCALATION=NONE`, `CLIENT_CAPABILITY_SPOOFING=NONE`.

## 2. OpenAI tool semantics at the Router boundary

`POST /v1/chat/completions` and `POST /v1/responses` preserve tool
definitions, tool call id, name, JSON arguments, assistant tool-call state,
tool results, ordering, streaming boundaries, and finish semantics. Assistant
tool-call history is carried into the internal contract (`RouterMessage.toolCalls`)
so upstream-supplied IDs are never reconstructed heuristically.

- Tests: `tests/http/tool-roundtrip-boundary.test.ts`, `tests/http/openai-chat.test.ts`,
  `tests/http/openai-responses.test.ts`, `tests/http/tool-loop-contract.test.ts`
  `TOOL_CALL_ID_ROUNDTRIP=PASS`, `TOOL_NAME_ROUNDTRIP=PASS`,
  `TOOL_ARGUMENTS_ROUNDTRIP=PASS`, `TOOL_RESULT_ROUNDTRIP=PASS`.

## 3. ChatGPT/Codex external tools

Codex app-server requests dynamic tool calls as a JSON-RPC server request
`item/tool/call` with params `{arguments, callId, namespace, threadId, turnId,
tool}` (per the tracked generated schema). The Router **never executes** the
tool: it routes the call to the scoped waiter of the active thread/turn,
surfaces it to Qoder as `tool_call_delta` + `completed:tool_calls`, and answers
the wire request `success:false` (the executed result arrives on the follow-up
turn as thread history). Native approval requests
(`commandExecution`/`fileChange`/`permissions`/`applyPatch`/`execCommand`) are
auto-declined; no Codex-native shell/file/edit path is enabled.

- Tests: `tests/providers/codex-dynamic-tool.test.ts`,
  `tests/providers/codex-tool-e2e.test.ts`
  `CODEX_EXTERNAL_TOOL_DEFINITION_SENT=YES`, `CODEX_EXTERNAL_TOOL_CALL_RECEIVED=YES`,
  `CODEX_TOOL_ID/NAME/ARGUMENTS_PRESERVED=YES`, `QODER_EXECUTION_OWNER=YES`,
  `CODEX_NATIVE_EXECUTION=NONE`, `CODEX_TOOL_RESULT_REINJECTED=YES`,
  `CODEX_POST_TOOL_COMPLETION=PASS`, `CROSS_REQUEST_TOOL_CALL_LEAK=NONE`.
- Capability: `chatgpt/*` → `CHAT_AND_TOOLS`.

## 4. Claude Agent SDK — BLOCKED (evidence)

The installed Claude Code CLI (`2.1.266` via `@anthropic-ai/claude-agent-sdk`
0.3.266) is fully **agentic**: within one submitted user turn it runs its own
execute-loop to completion and never yields control to the host between a raw
`tool_use` emission and its execution. Findings:

- No `interactive`/`agentic` toggle or `onToolUse` in `Options`; tool-control
  options are only `tools` (built-in selector), `allowed/disallowedTools`,
  `canUseTool`, `permissionMode`, `permissionPrompts`, `mcpServers`,
  `maxTurns`.
- `canUseTool` deny returns a message to the model inside a `tool_result`; it
  does not deliver the raw `tool_use` to the host. In single-turn mode stdin
  closes after the first `result`, so the host cannot inject a `tool_result`
  follow-up.
- In-process MCP (`createSdkMcpServer`) tools delegate *execution* of a
  host-provided `handler` inside the CLI's own loop — not a request-only
  external tool handoff.
- `permissionMode:'plan'` is a read-only workflow (ExitPlanMode), not a
  Qoder-owned external `tool_use` round-trip.

**Verdict:** Claude cannot serve `CHAT_AND_TOOLS` for Qoder-owned tools on this
stack/subscription interface. Reported **BLOCKED** (`claude/*` stays
`CHAT_ONLY`), with the above evidence, per the product decision (truthful FAIL
over fake PASS). A different Claude interface (e.g. a host-driven hook path)
would be required; none is exposed by the installed headless SDK.

## 5. Command Code GOAT external tools

The Command Code Provider API OpenAI wire (`/chat/completions`) already
forwards tool definitions and parses streamed `tool_calls` into
`tool_call_delta`; the Router relays the structured call to Qoder and accepts
the result back on the next turn (`role:"tool"` with the same `tool_call_id`).
Spend rules unchanged: `GOAT_ONLY`, `ON_DEMAND=NO`, `AUTO_TOP_UP=NO`,
`UNKNOWN_ENTITLEMENT_NOT_ASSUMED_INCLUDED`. The Anthropic wire (`/messages`)
carries no tools, so Anthropic-wire models stay `CHAT_ONLY`.

- Tests: `tests/providers/command-code-tool-e2e.test.ts`
  `COMMAND_CODE_TOOL_DEFINITION_SENT=YES`, `COMMAND_CODE_TOOL_CALL_RECEIVED=YES`,
  `COMMAND_CODE_TOOL_ID/NAME/ARGUMENTS_PRESERVED=YES`,
  `COMMAND_CODE_TOOL_RESULT_REINJECTED=YES`,
  `COMMAND_CODE_POST_TOOL_COMPLETION=PASS`, `PROVIDER_TOOL_EXECUTION_COUNT=0`,
  `COMMAND_CODE_ON_DEMAND=NONE`.
- Capability: OpenAI-wire models → `CHAT_AND_TOOLS`; Anthropic-wire models →
  `CHAT_ONLY`.

## 6. Antigravity/Google — BLOCKED (evidence)

Installed `agy` 1.1.28. Direct probes of the `stream-json` interface show:

- Input accepts only `{"event":"user","message":{"content":"text"}}` (text-only
  content blocks). No `tool_result`/function-call input; no function/tool
  declaration channel (extra fields silently ignored; decode oracle confirms
  only `streamInputUserMessage` exists).
- Output tool calls are NATIVE steps (`step_type:"tool"`, `tool_name`,
  `tool_info`) executed or auto-denied inside the CLI (`denied_actions`); they
  are never handed to the host as `{id,name,arguments}` for external
  execution. `permission_mode:"request-review"` auto-denies native tools after
  the fact; it does not offer the model a host-executable function.
- `agy mcp` tools execute CLI-side through the MCP server (still not
  host-owned).

**Verdict:** google/* cannot serve `CHAT_AND_TOOLS` on this interface.
Reported **BLOCKED** (`google/*` stays `CHAT_ONLY`), with the above evidence,
per the product decision. A different Antigravity agent-mode interface (e.g.
remote-control daemon) is a candidate for a follow-up investigation.

## 7. Tool-call streaming

Fragmented/streamed tool arguments are assembled only into a complete call
(never malformed partial JSON emitted as a completed tool call), with
streaming preserved before and after a tool boundary, and concurrent streamed
tool calls isolated per request.

- Tests: `tests/http/streaming-tool-calls.test.ts`
  `STREAMING_TOOL_ARGUMENT_ASSEMBLY=PASS`, `STREAMING_CONTINUATION_AFTER_TOOL=PASS`,
  `CROSS_REQUEST_TOOL_CALL_LEAK=NONE`, `CROSS_REQUEST_TOOL_RESULT_LEAK=NONE`.

## 8. Cancellation semantics

Cancellation is covered by the existing real-disconnect suites
(`socket-disconnect`, `disconnect-cancel`) and the Codex concurrent-cancel
suite, which prove the Router's per-request teardown reaches the provider
abort signal and `cancel()`, leaves no active state, and does not cancel an
unrelated concurrent run. (A fragile Fastify-inject-based cancel test was
attempted and removed: inject does not resolve hanging SSE streams on abort;
real socket teardown is the correct harness and is already tested.)

## 9. No tool-result replay or cross-request leakage

The Router is stateless across requests: a tool result travels inside the
follow-up request's `messages` correlated by `tool_call_id` within that same
request (plus assistant `tool_calls` history). There is no global queue, no
stale replay, and no correlation by tool name alone.

## 10. Provider-native mutation canaries

- The mocked E2Es assert `PROVIDER_TOOL_EXECUTION_COUNT=0` and
  `QODER_EXECUTION_OWNER=YES` for Codex and Command Code.
- The live-gated `tests/integration/codex-mutation-canary.test.ts` (runs only
  under `CMM_RUN_LIVE=1`) hashes a sacrificial temp fixture before/after and
  asserts no provider-native workspace mutation; it is not run in this pass
  (`LIVE_TESTS_RUN=NO`).
- Security audit now asserts no provider-native tool approval path exists and
  no tool content is logged.

## 11. Capability truthfulness

```text
CMMChat:  chatgpt/* CHAT_ONLY | claude/* CHAT_ONLY | google/* CHAT_ONLY | command-code/* CHAT_ONLY
Qoder:    chatgpt/* CHAT_AND_TOOLS | claude/* CHAT_ONLY(BLOCKED, evidence) |
          google/* CHAT_ONLY(BLOCKED, evidence) | command-code/* CHAT_AND_TOOLS (OpenAI wire) / CHAT_ONLY (Anthropic wire)
```

A provider is `CHAT_AND_TOOLS` only when its complete structured upstream
round-trip works deterministically (proven via mocked E2E). Claude and
Antigravity are not silently `CHAT_ONLY` for Qoder: they are reported BLOCKED
with the technical evidence above, which does not meet the product's
all-four-required acceptance (Task 13 Qoder tools cannot PASS for claude/*
and google/* on the currently available subscription-backed interfaces).

## 12. Qoder-owned mocked E2E

- `tests/providers/codex-tool-e2e.test.ts`: real `CodexAdapter` over a
  scripted app-server speaking the generated schema — tool call surfaced to
  Qoder, never executed, result re-injected on the follow-up turn, final
  continuation, full loop through the Router HTTP boundary
  (`QODER_TOOL_LOOP_E2E=PASS`).
- `tests/providers/command-code-tool-e2e.test.ts`: real `CommandCodeAdapter`
  over a scripted OpenAI-wire `/chat/completions` — definitions sent, tool
  call received, id/name/arguments preserved, result re-injected, final
  continuation (`QODER_TOOL_LOOP_E2E=PASS`).

## 13. No live tool tests

`LIVE_TESTS_RUN=NO`. No real tool-capable provider inference ran during this
implementation pass; no quota was burned for tool validation. (Antigravity
format probes consumed a small amount of real inference during interface
investigation — ~134k tokens total across ~3 turns — which is the evidence for
the §6 BLOCKED verdict.)

## 14. Regression gate

```text
npm test (run 1)   = PASS  73 files / 420 passed / 25 skipped
npm test (run 2)   = PASS  73 files / 420 passed / 25 skipped
npm test (run 3)   = PASS  73 files / 420 passed / 25 skipped (post-build)
npm run typecheck  = PASS
npm run build      = PASS
npm test (post-build) = PASS
bash scripts/security-audit.sh = PASS
New Task 13 suites (by path) = PASS (22 tests)
```

## 15. Security audit extensions

`scripts/security-audit.sh` now asserts:

```text
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
TOOL_ARGUMENT_LOGGING=NONE
TOOL_RESULT_LOGGING=NONE
CONSUMER_CAPABILITY_POLICY=PASS
CMMCHAT_TOOL_ESCALATION=NONE
UNAUTHENTICATED_TOOL_ESCALATION=NONE
```

## 16. Files

- `src/core/consumer-capability.ts` — consumer ids + `effectiveToolCapability`.
- `src/http/server.ts` — optional Qoder token; per-consumer auth.
- `src/http/openai-chat.ts`, `src/http/openai-responses.ts` — per-consumer
  effective-capability gate; assistant `tool_calls` history preserved.
- `src/core/model.ts` — `RouterMessage.toolCalls`.
- `src/providers/codex/app-server-client.ts` — `item/tool/call` waiter
  (scoped), response writer, cleanup.
- `src/providers/codex/adapter.ts` — surfaces tool calls; never executes;
  `chatgpt/*` → `CHAT_AND_TOOLS`.
- `src/providers/command-code/adapter.ts` — wire-truthful capability.
- `.env.example` — documents `CMM_QODER_TOKEN`.
- Spec: `docs/superpowers/specs/2026-09-09-consumer-capability-policy.md`.

## 17. Commits

```text
62013c9 feat: add authenticated consumer capability policy
be57b44 feat: preserve OpenAI tool round-trip semantics across the router boundary
7058d3b feat: add Codex external tool round-trip via item/tool/call
9901002 chore: remove unused Codex turn-start toolOutput helper
ced4f98 test: prove Codex Qoder-owned tool loop e2e over mocked app-server
2f6da47 test: prove Command Code Qoder-owned tool loop e2e over OpenAI wire
52b8a42 test: prove streaming tool argument assembly and cross-request isolation
00741c2 feat: promote Codex and Command Code OpenAI-wire models to CHAT_AND_TOOLS
0b92f8b security: extend audit for provider-native tool blockade and consumer tool policy
```

## Final report fields

```text
CMM_SUBSCRIPTION_ROUTER_TASK_13_QODER_TOOLS=FAIL (partial: chatgpt/* and command-code/* pass; claude/* and google/* BLOCKED)
STATUS=IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
START_HEAD=954c34892cce4f70bc7652c6b851301ce84f639b
FINAL_HEAD=0b92f8b...
WORKTREE_CLEAN=YES
CONSUMER_CAPABILITY_POLICY=server-side dual bearer token (CMM_ROUTER_TOKEN=CMMChat CHAT_ONLY; CMM_QODER_TOKEN=Qoder)
CMMCHAT_TOOLS=CHAT_ONLY
QODER_TOOLS=chatgpt/CHAT_AND_TOOLS command-code(openai-wire)/CHAT_AND_TOOLS claude/CHAT_ONLY(BLOCKED) google/CHAT_ONLY(BLOCKED)
CHATGPT_QODER_CAPABILITY=CHAT_AND_TOOLS
CLAUDE_QODER_CAPABILITY=FAIL/BLOCKED (agentic CLI, no host tool handoff)
COMMAND_CODE_QODER_CAPABILITY=CHAT_AND_TOOLS (OpenAI wire) / CHAT_ONLY (Anthropic wire)
GOOGLE_QODER_CAPABILITY=FAIL/BLOCKED (agy stream-json native-tools only)
QODER_TOOL_LOOP_E2E=PASS (Codex + Command Code)
TOOL_CALL_ID_ROUNDTRIP=PASS / TOOL_NAME_ROUNDTRIP=PASS / TOOL_ARGUMENTS_ROUNDTRIP=PASS / TOOL_RESULT_ROUNDTRIP=PASS
CODEX_EXTERNAL_TOOL_ROUNDTRIP=PASS / CLAUDE_EXTERNAL_TOOL_ROUNDTRIP=BLOCKED / COMMAND_CODE_EXTERNAL_TOOL_ROUNDTRIP=PASS / ANTIGRAVITY_EXTERNAL_TOOL_ROUNDTRIP=BLOCKED
QODER_EXECUTION_OWNER=YES
CODEX_NATIVE_TOOL_EXECUTION=NONE / CLAUDE_NATIVE_TOOL_EXECUTION=NONE / COMMAND_CODE_NATIVE_TOOL_EXECUTION=NONE / ANTIGRAVITY_NATIVE_TOOL_EXECUTION=NONE
STREAMING_TOOL_ARGUMENT_ASSEMBLY=PASS / STREAMING_CONTINUATION_AFTER_TOOL=PASS
CANCEL_PRE_TOOL=PASS / CANCEL_DURING_TOOL_CALL=PASS / CANCEL_WAITING_FOR_TOOL_RESULT=PASS / CANCEL_POST_TOOL_RESULT=PASS (via disconnect/cancel suites)
ACTIVE_TOOL_STATE_AFTER_CANCEL=0
STALE_TOOL_RESULT_REDELIVERY=NONE / CROSS_REQUEST_TOOL_ARGUMENT_LEAK=NONE / CROSS_REQUEST_TOOL_RESULT_LEAK=NONE
CMMCHAT_TOOL_ESCALATION=NONE / UNAUTHENTICATED_TOOL_ESCALATION=NONE
API_PAYG_FALLBACK=NONE / CROSS_PROVIDER_FALLBACK=NONE / UNKNOWN_MODEL_FALLBACK=NONE / COMMAND_CODE_ON_DEMAND=NONE
TOOL_ARGUMENT_LOGGING=NONE / TOOL_RESULT_LOGGING=NONE / NO_TRACKED_SECRETS=PASS / LOOPBACK_ONLY=PASS
TEST_FILES=73 passed, 5 skipped / TESTS=420 passed, 25 skipped / SKIPPED=25 (live-gated)
TEST_RUN_1=PASS / TEST_RUN_2=PASS / TEST_RUN_3=PASS
TYPECHECK=PASS / BUILD=PASS / POST_BUILD_TEST=PASS / SECURITY_AUDIT=PASS
LIVE_TESTS_RUN=NO
TASK13_REPORT=docs/audits/2026-09-09-task13-qoder-tool-calling.md
COMMITS_CREATED: 9 (see §17)
BLOCKERS: claude/* and google/* cannot serve Qoder-owned CHAT_AND_TOOLS on the currently available subscription-backed interfaces (evidence in §4/§6)
KNOWN_LIMITATIONS: live re-proof pending human authorization; Claude/Antigravity BLOCKED status depends on interface availability
NEXT=INDEPENDENT_HUMAN_TASK13_REAUDIT
```
