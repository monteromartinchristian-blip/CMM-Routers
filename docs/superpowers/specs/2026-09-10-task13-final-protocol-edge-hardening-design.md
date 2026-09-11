# Task 13 — Final Protocol Edge Hardening (Delta Design)

**Date:** 2026-09-10
**START_HEAD:** `3dc457497e749425766e71d82f2c39f83f5c25bb`
**Authoritative input:** `docs/audits/2026-09-10-independent-task13-mcp-hardening-reaudit-516ccdd.md`
**Status:** design — not a permission gate

## Purpose

The independent re-audit of `516ccdd` returns **FAIL** and withholds live-provider
acceptance. It confirms the two largest previous defects (Claude duplicate
provider-facing MCP process, Antigravity global single-session discovery) are
fixed, but lists concrete remaining deterministic gaps. This design is the narrow
delta that closes them. It does **not** reopen verified architecture.

## Non-goals / preserved invariants

Preserve exactly (audit §16):

- CMMChat `CHAT_ONLY` boundary; Qoder bearer boundary; PAYG fail-closed; loopback-only.
- Codex 0.153.4: `experimentalApi=true`, dynamic tools, declared-tool ACL, same-thread
  and same-turn continuation, original `item/tool/call` resolution, public/internal id split.
- `DeferredToolBroker` production composition + max pending + TTL + id split.
- Claude: one SDK-owned provider-facing MCP process; Router-side `BridgeControlServer`
  only; protocol-faithful fake SDK E2E.
- Antigravity: `agy 1.2.0`; ancestor-pid session routing; two concurrent sessions.
- Command Code: OpenAI tool wire; Anthropic tool wire; PAYG/on-demand protections.
- Responses `function_call`/`function_call_output` identity lifecycle; 1 MiB tool-result bound;
  Qoder bearer provisioning; OAuth isolation; logging hygiene.

No stylistic rewrites. No live provider inference in this phase.

## D1 — API-specific `tool_choice` wire normalization (P0 #1)

**Defect.** `normalizeToolChoice()` in `src/core/tool-policy.ts` accepts only the Chat
Completions named-function shape `{type:"function",function:{name}}`. Both HTTP
surfaces share it, so the canonical Responses shape `{type:"function",name}` is
rejected `invalid_request` at `src/http/openai-responses.ts`.

**Design.** Separate WIRE PARSING from INTERNAL POLICY:

```
Chat wire   -> parseChatToolChoice(raw)      -+
Responses wire -> parseResponsesToolChoice(raw) -+-> ToolChoicePolicy
                                                   -> enforceProviderToolPolicy(provider, policy, parallel?)
```

`ToolChoicePolicy = {kind:"auto"|"none"|"required"} | {kind:"named";name:string}`.
Both parsers return the same internal value for an equivalent wire request.
Provider policy consumes ONLY the normalized form and never learns which public API
produced it. The normalized policy is carried on the `RouterRequest` so provider
adapters (Command Code Anthropic mapping) also consume the normalized form.

**Tests.** `tests/http/tool-choice-wire-normalization.test.ts` sends the literal
public wire shape of each endpoint (never the same object for both):

- `CHAT_NAMED_FUNCTION_TOOL_CHOICE_WIRE=PASS`
- `RESPONSES_NAMED_FUNCTION_TOOL_CHOICE_WIRE=PASS`
- `CHAT_RESPONSES_TOOL_CHOICE_NORMALIZE_TO_SAME_INTERNAL_VALUE=PASS`
- `RESPONSES_CANONICAL_NAMED_FUNCTION_TOOL_CHOICE=PASS`

## D2 — Antigravity stream overflow must fail closed (P0 #2)

**Defect.** `StreamEventQueue.push()` sets `overflowed=true` and silently drops the
event; `didOverflow()` has no production consumer.

**Design.** `push()` becomes terminal-on-overflow: it atomically enters a terminal
overflow state, refuses all further events, and signals the adapter. The adapter
aborts the exact agy run, emits `provider_protocol_error` exactly once, emits no
successful completion afterwards, and runs the normal cleanup. A tiny-capacity queue
is injectable so the production path is exercised deterministically.

**Tests.** `ANTIGRAVITY_STREAM_QUEUE_BOUND`, `_OVERFLOW_OBSERVED`,
`_OVERFLOW_PROVIDER_ABORT`, `_OVERFLOW_PROTOCOL_ERROR`,
`_OVERFLOW_SUCCESS_AFTER_ERROR=NONE`, `_OVERFLOW_CLEANUP`.

## D3 — One real child-termination primitive (P0 #3)

**Defect.** Timeout path does SIGINT→2 s→SIGKILL; the ordinary `AbortSignal` path
does SIGINT only. TTL/post-result cancel therefore do not guarantee provider exit.

**Design.** One reusable primitive:

```
request graceful termination -> SIGINT -> bounded grace -> if alive SIGKILL
-> await close/error or bounded terminal verdict -> settle cleanup
```

used by timeout, `AbortSignal`, TTL session cleanup, post-result cancellation, fatal
protocol failure, bridge failure and provider teardown. No duplicate signal races, no
leftover timers. Tested against a REAL local fixture child that ignores SIGINT.

**Tests.** `AGY_ABORT_SIGINT_SENT`, `_ABORT_GRACE_PERIOD_BOUNDED`,
`_ABORT_SIGKILL_ESCALATION`, `_ABORT_CHILD_EXIT_OBSERVED`,
`ANTIGRAVITY_TTL_GUARANTEES_PROVIDER_PROCESS_EXIT`,
`ANTIGRAVITY_POST_RESULT_CANCEL_GUARANTEES_PROVIDER_PROCESS_EXIT`.

## D4 — Bound the provider-facing MCP stdio parser (P0 #4)

**Defect.** `src/bridge/mcp-bridge-process.ts` appends stdin into an unbounded
`buffer` before any newline.

**Design.** Finite `MAX_MCP_STDIO_FRAME_BYTES = 1 MiB` (consistent with the
Router-side `MAX_CONTROL_FRAME_BYTES` and the 1 MiB tool-result bound), enforced
WHILE accumulating. On overflow: discard retained frame state, never forward a
control-channel request, emit a JSON-RPC/protocol error, terminate the bridge
fail-closed, ensure provider/session cleanup. Frame-processing is extracted into a
production helper driven by the real entry point so tests hit the real path.

**Tests.** `MCP_PROVIDER_FACING_STDIO_FRAME_BOUND`,
`MCP_OVERSIZE_FRAME_FAIL_CLOSED`, `MCP_OVERSIZE_FRAME_SURFACED_TO_QODER=NONE`.

## D5 — MCP `tools/call` must be a valid JSON-RPC request (P0 #5)

**Defect.** `tools/call` with no `id` and/or no `jsonrpc:"2.0"` can still create an
executable Qoder call. Malformed JSON is silently `continue`d.

**Design.** Before any control-channel call, require: `jsonrpc==="2.0"`, `id` a
string|number, `method==="tools/call"`, `params` an object, `params.name` a declared
tool, `params.arguments` object-shaped. Otherwise fail closed and create no
Router/broker/tool state. Malformed provider frames follow a deliberate policy:
JSON parse failure → `-32700` with `id:null` then terminate fail-closed.

**Tests.** `MCP_TOOL_CALL_JSONRPC_VERSION_REQUIRED`, `_JSONRPC_ID_REQUIRED`,
`MCP_MALFORMED_TOOL_CALL_FAIL_CLOSED`, `MALFORMED_MCP_TOOL_CALL_SURFACED_TO_QODER=NONE`.

## D6 — Bound raw agy process output (P0 #6)

**Defect.** `SpawnInferenceRunner` appends `stdout`, `stderr` and the partial NDJSON
`lineBuffer` unbounded for the provider lifetime.

**Design.** `MAX_AGY_STDOUT_DIAGNOSTIC_BYTES`, `MAX_AGY_STDERR_DIAGNOSTIC_BYTES`
(capped diagnostic windows: retain a bounded prefix/suffix sufficient for error
mapping, never the whole stream) and `MAX_AGY_NDJSON_LINE_BYTES` (a single NDJSON
line beyond the bound → `provider_protocol_error`, provider abort, no successful
completion). Memory never grows proportionally to provider lifetime.

**Tests.** `AGY_STDOUT_ACCUMULATOR_BOUNDED`, `AGY_STDERR_ACCUMULATOR_BOUNDED`,
`AGY_NDJSON_PARTIAL_LINE_BOUNDED`, `AGY_OVERSIZE_NDJSON_FAIL_CLOSED`.

## D7 — Restart-safe registry + MCP registration (P0 #7)

**Defect.** `BridgeSessionRegistry` counts only its in-process Map; stale on-disk
descriptors survive restart and two Router processes can each exceed the global
bound. `agy mcp add` idempotence is remembered only in one adapter process.

**Design.**
1. On registration, reconcile the on-disk registry: remove malformed/stale
   descriptors (dead owner or missing control socket), never remove a
   verified-live one; count the EFFECTIVE live registry (disk ∪ memory); enforce the
   bound against it, under a simple local exclusive lock (atomic file create with
   bounded stale-lock recovery) so concurrent Router processes cannot jointly
   exceed `SESSION_REGISTRY_MAX_LIVE=64`.
2. `ensureAntigravityMcpRegistration()` / `reconcileAntigravityMcpRegistration()`
   inspect real `agy mcp list` output and make `cmm-qoder-tools` exactly one valid,
   enabled, secret-free registration with the correct command/args, repairing
   idempotently.

**Tests.** `SESSION_REGISTRY_STALE_DESCRIPTOR_RECONCILIATION`,
`_EFFECTIVE_DISK_BOUND`, `_MULTI_PROCESS_RACE_FAIL_CLOSED`, `_MAX_LIVE=64`,
`ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE`,
`_RECONCILIATION`, `_DUPLICATES=NONE`.

## D8 — Provider policy must be literal (P0 #8)

**Defect.** `claude`/`google` accept `parallel_tool_calls=false` on the theory that
the Router's single-parked-call limit *is* the provider constraint. No provider-side
parallel control is proven for Claude Agent SDK 0.3.266 or `agy 1.2.0`.

**Design.** Rule: faithfully represent OR reject; never pretend. For `claude` and
`google` accept ABSENCE of `parallel_tool_calls` and reject ANY explicit boolean
(`true` OR `false`) → `unsupported_capability`. `tool_choice` keeps `auto`/absent
(the CLI default) and rejects every other kind. Command Code and Codex semantics are
unchanged. Both HTTP surfaces behave consistently after D1 normalization.

**Tests.** `CLAUDE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION`,
`GOOGLE_EXPLICIT_PARALLEL_POLICY_NO_SILENT_APPROXIMATION`,
`SILENT_TOOL_POLICY_APPROXIMATION=NONE`.

## D9 — Multi-step Qoder agent loops + cancellation (P0 #9, #10)

**Defect.** Codex uses a one-shot `toolCallFuture`; Claude/Google gate sets
`gate.parked=true` and never resets after a successful result. A second sequential
tool request in one logical provider run is refused.

**Design.** Replace one-shot waiting with a reusable per-turn external-tool loop
that keeps the SAME logical provider run alive across tool A → result A → tool B →
result B → final answer, for every family claiming `CHAT_AND_TOOLS`:
chatgpt/Codex, claude, google/Antigravity, command-code (OpenAI + Anthropic wires).
Provider-faithful harnesses decide to request tool B ONLY after consuming result A
through the real production transport; finals carry two independent canaries proving
causality. Cancellation is retested at every new lifecycle edge (before A, waiting
A, between A and B, waiting B, after B before final, normal final) with full cleanup
and survival of unrelated concurrent runs.

## Global success criterion

`CMM_SUBSCRIPTION_ROUTER_TASK13_FINAL_PROTOCOL_EDGE_HARDENING=PASS` only when every
required deterministic marker in the goal is PASS, full regression ×3, typecheck,
build, post-build test and `scripts/security-audit.sh` are green, and no item is
skipped. Live provider inference stays OFF.

## Expected external blockers / live-only uncertainty

- The real Claude SDK MCP invocation and real `agy` MCP invocation remain live-canary
  items; this phase proves the protocol-faithful fake paths only.
- `agy mcp add` persistent behavior is proven against the installed 1.2.0 CLI without
  a model turn; if the on-disk backing store is opaque, the reconciler is proven
  against an injected runner plus the real list/add surface.
