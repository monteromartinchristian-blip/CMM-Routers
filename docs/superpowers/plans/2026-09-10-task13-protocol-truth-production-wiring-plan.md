# Task 13 — Protocol Truth & Production Wiring (Implementation Plan)

**Date:** 2026-09-10
**Design:** `docs/superpowers/specs/2026-09-10-task13-protocol-truth-production-wiring-design.md`
**Method:** TDD per finding — write/strengthen a test that FAILS on current code,
observe the intended failure, implement the minimum production fix, rerun, then
run adjacent tests.

Verification evidence must be wire bytes, production state, process/session
lifecycle, or HTTP behavior. Printing PASS markers is not evidence by itself.

---

## Phase A — Design + plan

- **A1** `docs: design Task 13 protocol truth production wiring`
- **A2** `docs: plan Task 13 protocol truth production wiring`

## Phase B — Codex experimental dynamic tools (P0 #1)

| Step | Action | Test (red first) | Marker |
| --- | --- | --- | --- |
| B1 | Track experimental fixture + provenance | `codex-experimental-schema.test.ts` asserts tracked fixture matches generated shape | `CODEX_DYNAMIC_TOOLS_SCHEMA_TRACKED` |
| B2 | Add `capabilities.experimentalApi:true` to initialize | `codex-experimental-opt-in.test.ts` asserts exact initialize body | `CODEX_EXPERIMENTAL_API_OPT_IN` |
| B3 | Add `dynamicTools` to `SchemaThreadStartParams` + `buildThreadStartParams` | translator unit test | — |
| B4 | Map `request.tools` → `FunctionDynamicToolSpec` and send on `thread/start` | `codex-tool-declaration.test.ts` asserts exact `thread/start` body | `CODEX_QODER_TOOL_DEFINITIONS_SENT` |
| B5 | Strict fake app-server rejects invalid declaration | `codex-strict-declaration-e2e.test.ts` — no tool call without valid declaration | `CODEX_STRICT_DECLARATION_E2E` |
| B6 | Fail closed on missing `callId`/`tool`/`threadId`/`turnId` | `codex-fail-closed-identity.test.ts` | `CODEX_MISSING_CALL_ID_FAIL_CLOSED`, `CODEX_PROVIDER_CALL_ID_FABRICATION=NONE` |
| B7 | Preserve same-turn continuation | existing `codex-same-turn-continuation.test.ts` must stay green | `CODEX_SAME_THREAD_CONTINUATION`, `CODEX_SAME_TURN_CONTINUATION`, `CODEX_NEW_THREAD_FOR_TOOL_RESULT=NO` |

## Phase C — Broker production composition (P0 #2)

| Step | Action | Test | Marker |
| --- | --- | --- | --- |
| C1 | Instantiate broker in `createProductionRegistry`, inject into adapters | `production-composition.test.ts` extended | `BROKER_PRODUCTION_INSTANTIATED` |
| C2 | Composite public↔provider identity mapping | `broker-public-identity.test.ts` | `BROKER_COMPOSITE_CORRELATION`, `PROVIDER_INTERNAL_CALL_ID_PRESERVED` |
| C3 | Adversarial isolation matrix | `broker-adversarial.test.ts` | `DUPLICATE_PROVIDER_CALL_ID_ISOLATION` |
| C4 | Bound + TTL through production path | extend `broker-adversarial` | `BROKER_PENDING_BOUND`, `BROKER_TTL` |
| C5 | Codex uses broker; cleanup on death/cancel | `codex-broker-lifecycle.test.ts` | `BROKER_PROVIDER_DEATH_CLEANUP` |

## Phase D — Command Code wires (P1)

| Step | Action | Test | Marker |
| --- | --- | --- | --- |
| D1 | Serialize `tool_choice`/`parallel_tool_calls` in concrete client | `command-code-openai-body.test.ts` inspects HTTP body | `COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY`, `..._PARALLEL_POLICY_HTTP_BODY` |
| D2 | Anthropic `tools[]` declaration | `command-code-anthropic-tools.test.ts` | `COMMAND_CODE_ANTHROPIC_TOOL_DECLARATION` |
| D3 | Parse `tool_use` + `input_json_delta` | same | `COMMAND_CODE_ANTHROPIC_TOOL_USE_PARSE`, `..._STREAMING_ARGUMENTS` |
| D4 | `tool_result` continuation, strict fake upstream | same | `COMMAND_CODE_ANTHROPIC_TOOL_RESULT_CONTINUATION` |

## Phase E — Responses lifecycle (P1)

| Step | Action | Test | Marker |
| --- | --- | --- | --- |
| E1 | Canonical `call_id` distinct from item `id` (non-stream) | `responses-function-call-output.test.ts` — exact keys | `RESPONSES_FUNCTION_CALL_CALL_ID`, `..._DISTINCT_FROM_ITEM_ID` |
| E2 | Streaming item lifecycle | `responses-function-call-stream.test.ts` | `RESPONSES_OUTPUT_ITEM_LIFECYCLE`, `..._ARGUMENTS_DELTA`, `..._ARGUMENTS_DONE` |
| E3 | Tool-result bound 1 MiB through real path | `tool-result-bound.test.ts` | `TOOL_RESULT_SIZE_BOUND`, `OVERSIZE_TOOL_RESULT_REJECTED_BEFORE_PROVIDER` |
| E4 | Malformed complete arguments fail closed | `malformed-tool-arguments.test.ts` | `MALFORMED_COMPLETE_TOOL_ARGUMENTS_FAIL_CLOSED` |
| E5 | Policy: no silent tool_choice/parallel drop | `tool-policy-rejection.test.ts` | `SILENT_TOOL_CHOICE_DROP=NONE`, `SILENT_PARALLEL_TOOL_POLICY_DROP=NONE` |
| E6 | Logging hygiene through real path | extend `log-hygiene.test.ts` | `TOOL_ARGUMENT_LOGGING=NONE`, `TOOL_RESULT_LOGGING=NONE` |

## Phase F — Claude + Antigravity bridges (P0 #3/#4)

| Step | Action | Test | Marker |
| --- | --- | --- | --- |
| F1 | Bridge-control IPC (Unix socket, token, 0600) | `bridge-control-ipc.test.ts` | `CLAUDE_BRIDGE_CONTROL_IPC` |
| F2 | External MCP bridge process (transport only) | `claude-bridge-process.test.ts` | `CLAUDE_EXTERNAL_BRIDGE_PROCESS` |
| F3 | Wire ClaudeAdapter `mcpServers` + continuation | `claude-adapter-tool-roundtrip.test.ts` | `CLAUDE_ADAPTER_MCP_WIRING`, `CLAUDE_SAME_LOGICAL_SESSION_CONTINUATION` |
| F4 | Wire AntigravityAdapter + lifecycle | `antigravity-adapter-tool-roundtrip.test.ts` | `ANTIGRAVITY_ADAPTER_MCP_WIRING`, `ANTIGRAVITY_SAME_RUN_CONTINUATION` |
| F5 | Native execution stays disabled | static + runtime assertions | `CLAUDE_NATIVE_TOOL_EXECUTION=NONE`, `ANTIGRAVITY_NATIVE_*=NONE` |

## Phase G — Provisioning, cancellation, security, evidence

| Step | Action | Marker |
| --- | --- | --- |
| G1 | Qoder bearer Keychain provisioning (docs + installer + launchd test) | `QODER_BEARER_PROVISIONING`, `QODER_FRESH_MAC_REPRODUCIBILITY` |
| G2 | Production cancellation matrix through real adapters | `PRODUCTION_CANCEL_*` |
| G3 | `scripts/security-audit.sh` static invariants | — |
| G4 | Evidence doc `docs/audits/2026-09-10-task13-protocol-truth-production-wiring-evidence.md` | — |

## Final regression gate

```bash
npm test && npm test && npm test
npm run typecheck
npm run build
npm test
bash scripts/security-audit.sh
```

Then every NEW Task 13 suite by explicit path. No deterministic Task 13
production-wiring test may be skipped. Only explicitly live-gated tests may be
skipped.

## Stability check

Wait for all workers; commit all intended work; `git status --short`; sleep 10;
`git status --short` again; verify HEAD unchanged and worktree clean. Print the
final report only after this passes. After the report, do not modify the repo.

## Commit discipline

Focused commits, no squash, no amend of historical commits, no push, no merge.
