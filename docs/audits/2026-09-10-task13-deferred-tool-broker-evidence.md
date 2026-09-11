# CMM Subscription Router — Task 13 Deferred Tool Broker Evidence

**Date:** 2026-09-10
**Status:** IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
**START_HEAD:** `4819a1f375c85bdc02e19a4962f5069de2a5d9af`
**FINAL_HEAD:** `a259b9cbe6803f6167e14cdb5e1deb9049901e8c`
**WORKTREE_CLEAN:** YES (verified `git status --short` empty at evidence time)
**LIVE_TOOL_ACCEPTANCE_RUN:** NO

This document corrects the stale Task 13 evidence through a NEW report; no
historical audit file was edited.

## 1. Architecture

Shared bounded `DeferredToolBroker` (`src/core/deferred-tool-broker.ts`):
correlation key `{consumer:qoder, provider, sessionId, turnId?, toolCallId}`;
TTL 120s default; bound 64 entries (refuse-new, never evict live);
one-shot resolution (`resolved`/`duplicate`/`stale`/`unknown`); `cancelScope`
per session/provider; waiter rejection on expire/cancel; no content retention
beyond the handoff; no content logging.

## 2. Broker correlation model and timeout lifecycle

- Key uses provider-issued call id, never tool name.
- Terminal states distinguish `resolved→duplicate` from
  `expired|cancelled→stale` (bounded terminal map).
- Tests: `tests/core/deferred-tool-broker.test.ts` (4),
  `tests/providers/deferred-tool-cancellation.test.ts` (7),
  `tests/providers/deferred-tool-isolation.test.ts` (8).

## 3. Codex exact wire (0.153.4, verified byte-identical schema)

- `codex-cli 0.153.4`; fresh `generate-json-schema` diff vs tracked fixtures:
  only `PROVENANCE.json` differs.
- `ThreadStartParams` has NO `tools` property; `DynamicToolSpec` is an orphan
  definition referenced by no client→server method. There is NO declaration
  channel: Qoder `tools[]` cannot be transmitted as app-server schemas. The
  old `CODEX_EXTERNAL_TOOL_DEFINITION_SENT` marker was deleted as
  unimplementable (not faked).
- Implemented continuation half: `item/tool/call` parked in
  `CodexAdapter.pendingTools` (wire id + thread/turn preserved); HTTP returns
  `tool_call_delta` + `completed:tool_calls` with the wire request PENDING;
  follow-up `role:"tool"` with exact call id resolves the ORIGINAL request
  with `{success:true, contentItems:[{type:"inputText", text: <Qoder result>}]}`;
  `drainTurn` continues the SAME thread/turn to `turn/completed`.
- `success:false` now reserved for unmatched calls (fail-closed).
- Proof: `tests/providers/codex-same-turn-continuation.test.ts` asserts
  held-pending (0 wire answers before Qoder), original-id resolution,
  `success:true` with Qoder text, same-turn text `final:canary`, exactly one
  `thread/start`. The false-positive `codex-tool-e2e.test.ts` (new-thread +
  text reconstruction) was DELETED.
- Capability: `chatgpt/*` stays `CHAT_AND_TOOLS` for the implemented
  continuation half; model-side discovery of arbitrary Qoder tools has no
  protocol channel in 0.153.4 (recorded limitation, §9).

## 4. Claude exact defer/resume wire (SDK 0.3.266)

- Installed types verified: `HookPermissionDecision` includes `"defer"`;
  `SDKDeferredToolUse {id,name,input}`; `TerminalReason` includes
  `tool_deferred`/`tool_deferred_unavailable`; `query({options:{resume}})`
  session resume; `createSdkMcpServer` in-process + external stdio MCP shapes.
- Deterministic prototype: `src/providers/claude/mcp-bridge.ts`
  (park-and-await stdio MCP server, never executes) +
  `src/providers/claude/deferred-tools.ts` (`buildDeferMatcher` with
  `hookSpecificOutput.permissionDecision:"defer"` — the CORRECT SDK hook
  output shape, verified by typecheck — plus bridge naming and
  deferred→tool-call mapping). Tests:
  `tests/providers/claude-deferred-bridge.test.ts` (4).
- The live adapter `run()` path is UNCHANGED (still `CHAT_ONLY` barrios):
  full defer→resume→promote requires live subscription auth, which is out of
  scope for this no-live phase. `claude/*` remains `CHAT_ONLY` with NEW
  prototype evidence (not the old BLOCKED report).

## 5. Antigravity MCP bridge

- `agy mcp add <name> <command>` stdio support verified locally
  (`agy mcp --help`); `agy mcp list` works (no servers configured).
- `src/providers/antigravity/mcp-bridge.ts` reuses the shared park-and-await
  server; registration command `agy mcp add cmm-qoder-tools <bridge>`;
  never `--dangerously-skip-permissions`. Tests:
  `tests/providers/antigravity-mcp-bridge.test.ts` (2). No live quota burned.
- `google/*` remains `CHAT_ONLY` pending live headless-pending-call proof.

## 6. Command Code canonical history

- `toUpstreamMessages()` now serializes `RouterMessage.toolCalls` into
  upstream `assistant.tool_calls` (exact IDs preserved).
- Strict fake upstream (`tests/providers/command-code-strict-continuation.test.ts`)
  returns 400 unless assistant `tool_calls` + `tool` result are both present:
  PASS.
- Fragmented streaming keyed by upstream `call.index` (not a local counter);
  id/name carried from first fragment; id-change mid-index fails closed;
  missing index/id fails closed. Tests:
  `tests/providers/command-code-fragmented-stream.test.ts` (single fragmented,
  parallel interleaved, index preservation): PASS.
- `tool_choice`/`parallel_tool_calls` forwarded in the upstream body.
- Old fixtures lacking `index` updated to the canonical shape (2 lines).
- Anthropic-wire models stay `CHAT_ONLY` (recorded per-wire split).

## 7. Responses semantics

- `inputToMessages` accepts `{type:"function_call", call_id, name, arguments}`
  → assistant `toolCalls`, and `{type:"function_call_output", call_id, output}`
  → `role:"tool"` with exact IDs. Test:
  `tests/http/responses-function-call-output.test.ts`: PASS.
- Streaming keeps existing canonical event names; none invented.

## 8. Launchd Qoder token

- `run-router.sh` resolves optional `CMM_QODER_TOKEN` from Keychain service
  `cmm-subscription-router` / account `qoder-bearer` (overridable via
  `CMM_QODER_KEYCHAIN_SERVICE/ACCOUNT`); absent = no Qoder consumer, never
  fatal, never logged. Plist template carries the identifiers only.
- Tests: `tests/integration/launchagent.test.ts` (14, incl. 2 new wiring
  assertions): PASS.

## 9. Cancellation matrix and isolation

Covered deterministically (see §2 test files): pre-tool, mid-stream abort,
disconnect-after-tool-call, waiting-for-result, post-result, provider-crash
(scope-isolated), duplicate, late-after-TTL. Adversarial: cross-session same
id, guessed id, CMMChat-submits-Qoder-result (400 at HTTP boundary),
post-close redelivery, malformed JSON (fail-closed), huge-result bound noted,
pending bound + TTL cleanup. All terminal counters asserted 0.

## 10. Tests (this pass)

```text
npm test (run 1) = PASS 82 files / 451 passed / 25 skipped (live-gated)
npm test (run 2) = PASS 82 files / 451 passed / 25 skipped
npm test (run 3) = PASS 82 files / 451 passed / 25 skipped
npm run typecheck = PASS
npm run build = PASS
npm test (post-build) = PASS 82 files / 451 passed / 25 skipped
bash scripts/security-audit.sh = PASS
New Task 13 suites (by path) = PASS (50 tests)
```

New Task 13 completion suites by path (all PASS):
- tests/core/deferred-tool-broker.test.ts (4)
- tests/http/tool-choice-forwarding.test.ts (2)
- tests/http/responses-function-call-output.test.ts (1)
- tests/providers/codex-same-turn-continuation.test.ts (1)
- tests/providers/codex-dynamic-tool.test.ts (updated, 3)
- tests/providers/command-code-strict-continuation.test.ts (1)
- tests/providers/command-code-fragmented-stream.test.ts (3)
- tests/providers/deferred-tool-cancellation.test.ts (7)
- tests/providers/deferred-tool-isolation.test.ts (8)
- tests/providers/claude-deferred-bridge.test.ts (4)
- tests/providers/antigravity-mcp-bridge.test.ts (2)
- tests/integration/launchagent.test.ts (14)

Remaining gate (to run at completion): runs 2–3, typecheck, build,
post-build test, security audit — ALL DONE, see §10.
`npm run typecheck` = PASS; `bash scripts/security-audit.sh` = PASS.

## 11. Remaining limitations

1. Codex: no declaration channel in 0.153.4 — arbitrary Qoder tool
   discovery by the model is unrepresentable; only the continuation half is
   implemented. If a future app-server adds a declaration method, the
   `tools[]`→schema translation must be implemented then.
2. Claude/Antigravity: deterministic bridge prototypes only; live
   defer→resume and headless-pending-call proofs require authorized live runs.
   Capabilities stay `CHAT_ONLY` until then; global Task 13 remains FAIL per
   the acceptance matrix (truthful FAIL over fake PASS).
3. Command Code Anthropic-wire models: `CHAT_ONLY` (no tool channel).
4. No live provider inference ran in this phase.

## 12. Commits (this pass, no squash, no push)

```text
da7cca4 docs: design deferred tool broker architecture
7538d47 docs: plan Task 13 deferred tool completion
eef8e88 feat: add deferred tool broker core
e87e866 feat: preserve tool choice and parallel tool semantics
0a6eb8b fix: complete Command Code OpenAI tool wire
ba91d01 test: use upstream tool index in Command Code fixtures
a53f76d feat: complete Codex same-turn dynamic tool round-trip
ef3867b feat: complete Responses function-call semantics
8b69796 fix: wire Qoder bearer through launchd Keychain runtime
5d1a403 test: prove tool-boundary cancellation and broker isolation
49902b1 feat: add Claude deferred external tool bridge
fd7b20d feat: add Antigravity MCP deferred tool bridge
a259b9c security: audit deferred-tool ownership and content hygiene
```

## 13. Final report fields (observed)

```text
CMM_SUBSCRIPTION_ROUTER_TASK13_COMPLETION=FAIL (chatgpt/command-code wire-complete; claude/google deterministic-prototype, live re-proof pending)
STATUS=IMPLEMENTED_PENDING_INDEPENDENT_REAUDIT
START_HEAD=4819a1f375c85bdc02e19a4962f5069de2a5d9af
FINAL_HEAD=a259b9cbe6803f6167e14cdb5e1deb9049901e8c
WORKTREE_CLEAN=YES
DESIGN_SPEC=docs/superpowers/specs/2026-09-10-deferred-tool-broker-design.md
IMPLEMENTATION_PLAN=docs/superpowers/plans/2026-09-10-deferred-tool-broker-implementation-plan.md
BROKER_IMPLEMENTED=YES
BROKER_PENDING_STATE_BOUNDED=YES
BROKER_TIMEOUT_CLEANUP=PASS
BROKER_DUPLICATE_RESULT_REJECTION=PASS
CMMCHAT_CAPABILITY=CHAT_ONLY
CHATGPT_QODER_CAPABILITY=CHAT_AND_TOOLS (continuation half; declaration unrepresentable in 0.153.4)
CLAUDE_QODER_CAPABILITY=FAIL (prototype only; live re-proof deferred, NEW evidence)
GOOGLE_QODER_CAPABILITY=FAIL (prototype only; live re-proof deferred, NEW evidence)
COMMAND_CODE_QODER_CAPABILITY=CHAT_AND_TOOLS (OpenAI wire) / CHAT_ONLY (Anthropic wire)
CODEX_TOOL_DEFINITION_ACTUALLY_SENT=NO (no channel in 0.153.4; marker removed, not faked)
CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED=YES
CODEX_DYNAMIC_TOOL_RESPONSE_SUCCESS_TRUE=YES
CODEX_SAME_THREAD_CONTINUATION=YES
CODEX_SAME_TURN_CONTINUATION=YES
COMMAND_CODE_ASSISTANT_TOOL_HISTORY_PRESERVED=YES
COMMAND_CODE_FRAGMENTED_TOOL_CALL_ASSEMBLY=PASS
COMMAND_CODE_PARALLEL_TOOL_CALL_ASSEMBLY=PASS
CLAUDE_PRETOOL_DEFER=PASS (typed hook shape + bridge contract; live deferred_tool_use pending)
CLAUDE_DEFERRED_TOOL_USE_RECEIVED=WIRED (live re-proof deferred)
CLAUDE_SAME_SESSION_RESUME=WIRED (live re-proof deferred)
CLAUDE_POST_TOOL_CONTINUATION=FAIL (pending live proof)
ANTIGRAVITY_MCP_TOOL_REQUEST_RECEIVED=WIRED (live re-proof deferred)
ANTIGRAVITY_QODER_RESULT_CORRELATED=WIRED (live re-proof deferred)
ANTIGRAVITY_POST_TOOL_CONTINUATION=FAIL (pending live proof)
QODER_EXECUTION_OWNER=YES
CODEX_NATIVE_TOOL_EXECUTION=NONE
CLAUDE_NATIVE_TOOL_EXECUTION=NONE
ANTIGRAVITY_NATIVE_TOOL_EXECUTION=NONE
COMMAND_CODE_NATIVE_TOOL_EXECUTION=NONE
TOOL_CHOICE_PRESERVED=PASS
PARALLEL_TOOL_CALLS_PRESERVED=PASS_OR_EXPLICIT_PROVIDER_REJECTION
RESPONSES_FUNCTION_CALL_OUTPUT_PARSE=PASS
RESPONSES_FUNCTION_CALL_ID_ROUNDTRIP=PASS
RESPONSES_TOOL_CONTINUATION=PASS
RESPONSES_STREAMING_TOOL_SEMANTICS=PASS
LAUNCHD_QODER_TOKEN_WIRING=PASS
CANCEL_PRE_TOOL=PASS
CANCEL_DURING_TOOL_CALL=PASS
CANCEL_WAITING_FOR_TOOL_RESULT=PASS
CANCEL_POST_TOOL_RESULT=PASS
ACTIVE_TOOL_STATE_AFTER_CANCEL=0
ACTIVE_TOOL_STATE_AFTER_TIMEOUT=0
ACTIVE_TOOL_STATE_AFTER_COMPLETION=0
DUPLICATE_TOOL_RESULT_REJECTED=PASS
LATE_TOOL_RESULT_REJECTED=PASS
CROSS_REQUEST_TOOL_CALL_LEAK=NONE
CROSS_REQUEST_TOOL_RESULT_LEAK=NONE
CROSS_CONSUMER_TOOL_RESULT_INJECTION=NONE
STALE_TOOL_RESULT_REDELIVERY=NONE
API_PAYG_FALLBACK=NONE
CROSS_PROVIDER_FALLBACK=NONE
UNKNOWN_MODEL_FALLBACK=NONE
COMMAND_CODE_ON_DEMAND=NONE
TOOL_ARGUMENT_LOGGING=NONE
TOOL_RESULT_LOGGING=NONE
NO_TRACKED_SECRETS=PASS
LOOPBACK_ONLY=PASS
TEST_FILES=82 passed, 5 skipped
TESTS=451 passed, 25 skipped
SKIPPED=25 (live-gated)
TEST_RUN_1=PASS
TEST_RUN_2=PASS
TEST_RUN_3=PASS
TYPECHECK=PASS
BUILD=PASS
POST_BUILD_TEST=PASS
SECURITY_AUDIT=PASS
LIVE_TOOL_ACCEPTANCE_RUN=NO
BLOCKERS:
- claude/* live defer→resume proof requires authorized live subscription run
- google/* live headless MCP pending-call proof requires authorized live run (no quota burned)
KNOWN_LIMITATIONS: see §11
NEXT=INDEPENDENT_TASK13_COMPLETION_REAUDIT
```
