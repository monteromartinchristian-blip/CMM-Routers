# Deferred Tool Broker — Design Specification

**Date:** 2026-09-10
**Status:** Approved for implementation (Task 13 completion)
**Scope:** Qoder-owned tool execution across Codex, Claude, Antigravity, Command Code
**Supersedes (narrowly):** Task 13 §3–§6 wire defects listed in
`docs/audits/2026-09-10-independent-task13-reaudit-0ffc145.md`
**Does not reopen:** Reaudit-6 remediations, consumer-capability policy,
PAYG guards, loopback, preflight, remote-worker contract.

## 0. Schema facts (verified 2026-09-10, not memory)

All claims below were verified against the installed runtimes on this machine.

### 0.1 Codex app-server 0.153.4 (`codex --version` = `codex-cli 0.153.4`)

- Fresh `codex app-server generate-json-schema` output is byte-identical to
  `tests/fixtures/generated/codex/` (diff shows only `PROVENANCE.json`).
- `ThreadStartParams` top-level properties: `approvalPolicy`,
  `approvalsReviewer`, `baseInstructions`, `config`, `cwd`,
  `developerInstructions`, `ephemeral`, `model`, `modelProvider`,
  `personality`, `sandbox`, `serviceName`, `serviceTier`,
  `sessionStartSource`, `threadSource`. **No `tools` property.**
- `DynamicToolSpec` / `DynamicToolNamespaceTool` exist as **orphan
  definitions** inside `ThreadStartParams.json`: no top-level property of any
  `ClientRequest` method references them (`NO_TOP_LEVEL_REF` by exhaustive
  search of all `ClientRequest` `oneOf` params for `"tools"`/`DynamicTool`).
- `TurnStartParams` properties include `toolOutput: TurnToolOutput{name,
  namespace?, output: FunctionCallOutputBody}` where the body is a string or
  `input_text`/`input_image`/`input_audio`/`encrypted_content` items.
- Server→client requests (`ServerRequest`): exactly 10 methods, including
  `item/tool/call` with params `{arguments, callId, threadId, tool, turnId,
  namespace?}` and `item/tool/requestUserInput`.
- `DynamicToolCallResponse` requires `{success: boolean, contentItems: []}`
  with item types `inputText`/`inputImage`/`inputAudio`.
- Client→server methods: `thread/start`, `turn/start`, `turn/steer`,
  `thread/inject_items`, `mcpServer/tool/call`, `config/*`, etc. No method
  accepts a dynamic-tool declaration.

**Consequence (architectural, non-negotiable): there is no client→server
dynamic-tool declaration channel in 0.153.4.** Qoder `tools[]` cannot be
transmitted as app-server tool schemas. Any test asserting
`CODEX_EXTERNAL_TOOL_DEFINITION_SENT` against a declaration payload is
unimplementable and must be removed, not faked. The model emits
`item/tool/call` only for tools it already knows (built-in/MCP/configured);
the Router's job is the **continuation half**: hold the pending server
request, surface it to Qoder, resolve the ORIGINAL request with
`success:true` + Qoder's already-executed result, continue the SAME
thread/turn. Prompt-injecting tool schemas into `developerInstructions` as a
substitute declaration is forbidden (fake declaration, prompt injection
surface, unparsable arguments).

### 0.2 Claude Agent SDK 0.3.266 (`package.json` pinned)

- `HookPermissionDecision = 'allow'|'deny'|'ask'|'defer'`; `PreToolUse` hooks
  supported via `Options.hooks`.
- `SDKDeferredToolUse = {id, name, input}`; result carries
  `deferred_tool_use?` with `TerminalReason` including `tool_deferred` and
  `tool_deferred_unavailable`.
- Session resume: `query({options: {resume: sessionId}})`; `forkSession`
  option; `continue` mutually exclusive with `resume`.
- MCP: `Options.mcpServers`, `createSdkMcpServer({name, tools[]})` with
  in-process `handler(args, extra)`. External stdio MCP servers also
  supported through the same `mcpServers` config shape.
- Known risk (reaudit-cited SDK issue #370): in-process SDK MCP
  defer/resume is buggy; external stdio MCP is reported working. The design
  therefore uses an **external stdio MCP bridge** (separate process), never
  in-process handlers, for the Claude path.

### 0.3 Antigravity `agy` 1.1.28

- `agy mcp add <name> <command> [args...]` supports `--type stdio|http`;
  `agy mcp list` works locally (currently: no servers configured).
- Headless: `agy --print <prompt> --output-format stream-json --model <slug>
  --mode plan --sandbox`. `--dangerously-skip-permissions` is never used.
- `stream-json` input accepts only text user messages; native tool steps are
  CLI-side execution, never a host handoff. The design therefore uses a
  **custom local stdio MCP bridge** exactly as the reaudit recommends, and
  does not pursue `remote-control` (remote UI/session control daemon).

## 1. Ownership invariant (restated, binding)

```text
PROVIDER_OWNS_REASONING=YES
QODER_OWNS_TOOLS=YES / QODER_OWNS_FILESYSTEM=YES / QODER_OWNS_SHELL=YES / QODER_OWNS_EDITS=YES
ROUTER_EXECUTES_QODER_TOOLS=NO
PROVIDER_NATIVE_SHELL_EXECUTION=NO / PROVIDER_NATIVE_FILESYSTEM_MUTATION=NO
PROVIDER_NATIVE_CODE_EDIT=NO / PROVIDER_NATIVE_REPO_MUTATION=NO
```

A provider may **request** a tool. It may never execute the Qoder tool
itself. A `success:true` response carrying **Qoder's already-executed
result** is compatible with Qoder ownership and is not a blockade
violation. The current Codex `success:false` workaround is the opposite:
it closes the genuine continuation to satisfy a static check.

## 2. Deferred Tool Broker core (`src/core/deferred-tool-broker.ts`)

Coordination state only. Never executes. Never logs arguments/results.

### 2.1 Correlation key

```ts
interface BrokerKey {
  consumer: "qoder";            // only Qoder entries exist; CMMChat can never create one
  provider: ProviderId;         // chatgpt | claude | google | command-code
  sessionId: string;            // provider session/thread id
  turnId?: string;              // Codex turn, where applicable
  toolCallId: string;           // provider-issued call id (never tool name)
}
```

Minimum necessary fields. Tool name is payload, never identity. Two entries
with the same `toolCallId` in different sessions/requests are distinct.

### 2.2 Entry lifecycle

```text
PENDING (provider request parked, deadline armed)
  → RESOLVED (exactly one Qoder result accepted, waiter released)
  → EXPIRED   (deadline fired; late results rejected)
  → CANCELLED (caller abort / disconnect / provider death; waiters released)
Terminal entries are removed; resolution is one-shot.
```

Properties: bounded map (`MAX_PENDING = 64`, eviction refuses new entries
with `provider_rate_limited`, never evicts live ones); per-entry TTL
(default 120s, configurable); `AbortSignal` linkage per entry;
duplicate-result rejection (`DUPLICATE_TOOL_RESULT_REJECTED`);
stale-result rejection after terminal state (`LATE_TOOL_RESULT_REJECTED`);
no content in telemetry (`TOOL_ARGUMENT_LOGGING=NONE`,
`TOOL_RESULT_LOGGING=NONE`); counters for
`ACTIVE_TOOL_STATE_AFTER_{CANCEL,TIMEOUT,COMPLETION}=0`.

### 2.3 API (narrow)

```ts
createPendingCall(key, deadlineMs, signal?): PendingHandle  // throws when full
resolveCall(key, result: unknown): "resolved"|"duplicate"|"stale"|"unknown"
awaitCall(key): Promise<unknown>                            // settles on resolve/expire/cancel
cancelScope(filter: {sessionId?, requestId?}): void         // no cross-run cancellation
activeCount(): number
```

`result` is opaque bytes to the broker; ownership validation (consumer ==
Qoder, session liveness) happens at the HTTP boundary before `resolveCall`.

## 3. Provider wires

### 3.1 Codex: same-turn pending continuation (no declaration)

Because §0.1 proves no declaration channel exists:

1. `thread/start` unchanged (ephemeral per tool-loop, NOT per HTTP
   request — the thread must outlive one HTTP request; see step 5).
2. `turn/start` with text input only.
3. On `item/tool/call`: do NOT respond. Park `{threadId, turnId, callId,
   wireRequestId}` in the broker; yield `tool_call_delta` +
   `completed:tool_calls` to Qoder; end the HTTP response with the wire
   request still pending.
4. Follow-up Qoder request carries `role:"tool"` result + matching
   `callId`. Broker validates `(sessionId=threadId, turnId, toolCallId)`,
   then `respondToServerRequest(wireRequestId, {success:true,
   contentItems:[{type:"inputText", text: <Qoder result string>}]})`.
5. Continue listening on the SAME thread/turn for `turn/completed`.
   Thread lifetime is owned by a broker-scoped session object shared by the
   two HTTP requests (keyed by threadId returned to Qoder out-of-band in
   the tool-call response extension — see §6).
6. `success:false` is sent ONLY for unmatched tool calls (no broker entry /
   no Qoder tools declared) — fail-closed, never as a normal path.

Required proof markers (§A of brief): `CODEX_DYNAMIC_TOOL_REQUEST_HELD_PENDING`,
`CODEX_ORIGINAL_JSONRPC_REQUEST_RESOLVED`, `CODEX_DYNAMIC_TOOL_RESPONSE_SUCCESS_TRUE`,
`CODEX_SAME_THREAD_CONTINUATION`, `CODEX_SAME_TURN_CONTINUATION`,
`CODEX_NEW_THREAD_FOR_TOOL_RESULT=NO`. The old
`CODEX_EXTERNAL_TOOL_DEFINITION_SENT` marker is deleted as unimplementable.

Capability: `chatgpt/*` stays `CHAT_AND_TOOLS` only for the continuation
half that is genuinely implemented; the design document records that
model-side discovery of arbitrary Qoder tools has no protocol channel in
0.153.4, so live behavior is limited to model-initiated dynamic calls.

### 3.2 Command Code: canonical OpenAI wire completion

1. `toUpstreamMessages()`: serialize `RouterMessage.toolCalls` into
   upstream `assistant.tool_calls: [{id, type:"function",
   function:{name, arguments}}]` immediately before the matching
   `role:"tool"` message. Preserve exact IDs.
2. Fragmented streaming: key aggregation by upstream `call.index`
   (canonical), not a local counter; carry `id`/`name` from the first
   fragment; concatenate argument fragments per index. Cases: single
   fragmented call, two parallel fragmented calls, interleaved fragments,
   id/name only in first chunk.
3. Forward `tool_choice` and `parallel_tool_calls` (§4) into the upstream
   body; the fake upstream in tests rejects continuations missing the
   assistant `tool_calls` message.
4. Anthropic-wire models: unchanged `CHAT_ONLY` (no tool channel on
   `/messages`). The `command-code/*` family requirement is met per-wire;
   the evidence doc records the wire split explicitly instead of claiming
   all-model coverage.

### 3.3 Claude: external stdio MCP bridge + PreToolUse defer

1. New `src/providers/claude/mcp-bridge.ts`: a tiny standalone stdio MCP
   server exposing one tool per Qoder-requested function. Its handler does
   NOT execute: it parks `{id, name, input}` in the broker and awaits the
   Qoder result, then returns the already-produced result as MCP content.
2. Adapter passes the bridge via `Options.mcpServers` (external stdio
   transport) and registers a `PreToolUse` hook returning
   `permissionDecision:"defer"` for bridge tools. No filesystem/shell/edit
   tools are enabled (`disallowedTools` retained).
3. On `result.deferred_tool_use`: surface `{id, name, input}` to Qoder as
   `tool_call_delta` + `completed:tool_calls`; store `session_id`.
4. On Qoder follow-up: `resolveCall` into the broker, then
   `query({options:{resume: sessionId}})`; the parked MCP handler wakes
   with Qoder's result and returns it without side effects; Claude
   continues in the SAME session (`CLAUDE_SAME_SESSION_RESUME`).
5. If the installed SDK never yields `deferred_tool_use` for this shape
   (deterministic prototype decides), stop with the exact observed
   behavior as NEW hard evidence; do not restate the old BLOCKED report.
   `claude/*` promotes to `CHAT_AND_TOOLS` only on deterministic proof.

### 3.4 Antigravity: custom MCP bridge, same pattern

1. New `src/providers/antigravity/mcp-bridge.ts`: same park-and-await
   stdio MCP server (shared implementation with Claude's bridge where
   possible; one file, provider-tagged keys).
2. Router registers the bridge with `agy mcp add cmm-qoder-tools <node
   bridge.js>` (local config, documented in `docs/macos-install.md`;
   never `--dangerously-skip-permissions`).
3. Headless run blocks inside the MCP call while the Router returns the
   tool call to Qoder (bounded by `--print-timeout`); Qoder result
   resolves the pending MCP call; `agy` continues in the same run
   (`ANTIGRAVITY_POST_TOOL_CONTINUATION`).
4. Native `run_command`/`replace_file_content`/`write_to_file` remain
   denied; proof asserts `ANTIGRAVITY_NATIVE_*_EXECUTION=NONE`.
5. No live quota probes in this phase; the deterministic proof uses a fake
   MCP client speaking the bridge protocol. If headless `agy` cannot keep
   an MCP call pending across the split (prototype decides), STOP with the
   exact observed behavior and request authorization for a minimal live
   discovery probe (per brief §D) — do not burn quota automatically.

## 4. `tool_choice` / `parallel_tool_calls`

- Added to `RouterRequest` as `toolChoice?: unknown` and
  `parallelToolCalls?: boolean`; parsed in `openai-chat.ts` /
  `openai-responses.ts` (validated shape, stored, not merely inspected).
- Forwarded where representable: Command Code OpenAI wire (native fields).
- No representation: Codex app-server (no declaration channel, §0.1) —
  a forced `tool_choice:"required"`/`{"type":"function",...}` fails closed
  with `unsupported_capability` instead of being silently dropped; `"auto"`
  /`"none"` degrade explicitly and are recorded in the evidence doc.
  Claude/Antigravity MCP paths: bridge exposes exactly the requested tools;
  forcing is expressed by exposing a single tool; documented, not silent.
- Tests assert actual adapter outbound payloads.

## 5. Responses canonical semantics

`inputToMessages` additionally accepts top-level items without `role`:
`{type:"function_call", call_id, name, arguments}` → assistant `toolCalls`
history; `{type:"function_call_output", call_id, output}` → `role:"tool"`
message with `toolCallId=call_id`. IDs round-trip byte-exact. Streaming
keeps the Router's existing event names (`response.output_text.delta`,
`response.function_call_arguments.delta`, `response.completed`), which
match the canonical Responses deltas; no invented names are added.

## 6. Cross-request correlation transport

OpenAI HTTP has no out-of-band channel, so the first response in a
tool-loop carries the broker session id in a companion extension field
(`cmm_session_id` alongside the standard `tool_calls` payload — additive,
ignored by standard clients). The follow-up request echoes it back
(top-level `cmm_session_id`, stripped before provider forwarding).
Without it, correlation falls back to `(provider session, turnId,
toolCallId)` triple from message history; ambiguity fails closed.

## 7. Cancellation matrix (real tests, broker + Codex)

All eight brief-§H scenarios as deterministic tests: pre-tool cancel,
mid-stream-arguments cancel, disconnect after tool_call returned,
cancel-while-waiting (broker `cancelScope`), cancel post-result
pre-continuation, provider-crash-with-pending (client `stop()` releases
waiters), duplicate result, late result after TTL. Plus adversarial §I:
same call id across requests/sessions, wrong-request guessed id,
CMMChat-submits-Qoder-result (consumer check at HTTP boundary),
post-close-session delivery, malformed JSON arguments (fail-closed before
broker insert), huge result bound (1MiB cap, `provider_protocol_error`
beyond), disconnect-with-pending cleanup. Counters asserted zero after
each terminal path; unrelated concurrent runs never cancelled.

## 8. Launchd Qoder token wiring

- Plist template gains `CMM_QODER_KEYCHAIN_SERVICE` /
  `CMM_QODER_KEYCHAIN_ACCOUNT` (default `cmm-subscription-router` /
  `qoder-bearer`); `run-router.sh` resolves `CMM_QODER_TOKEN` from Keychain
  exactly like the router bearer (optional: absent = no Qoder consumer,
  unchanged behavior); installer documents `security add-generic-password`
  for the Qoder token; no secret values in tracked files.
- Tests: `LAUNCHD_QODER_TOKEN_WIRING`, `QODER_CONSUMER_AFTER_LAUNCHD_START`
  (server boot with Keychain-sourced env simulation),
  `LAUNCHD_NO_SECRET_VALUES_TRACKED`.

## 9. Capability promotion rules

- `chatgpt/*`: `CHAT_AND_TOOLS` (continuation half, §3.1) with the §0.1
  declaration limitation recorded.
- `command-code/*` OpenAI-wire: `CHAT_AND_TOOLS`; Anthropic-wire:
  `CHAT_ONLY` (recorded per-wire, not per-family-fake).
- `claude/*`, `google/*`: `CHAT_AND_TOOLS` only after deterministic
  bridge proof; otherwise `CHAT_ONLY` + NEW hard evidence. Global Task 13
  remains FAIL until all four Qoder families pass (brief acceptance
  matrix); truthful FAIL over fake PASS.
- CMMChat: `CHAT_ONLY` everywhere, unchanged.

## 10. Test strategy (TDD, red first)

For each §A–§I item: strengthen/write the failing test against current
`HEAD`, capture the failure reason, implement the minimum production
change, green the targeted suite, then adjacent suites. No `PASS`-label
echo tests: every new test asserts wire bytes or broker state. False
positives removed: `CODEX_EXTERNAL_TOOL_DEFINITION_SENT`,
`success:false`-as-proof, text-reconstruction E2E, tool-id-agnostic
Command Code E2E, unscoped cancellation claims.

## 11. Non-goals / stop conditions (brief §M, §STOP)

No live provider inference in this phase (`LIVE_TOOL_ACCEPTANCE_RUN=NO`).
No PAYG, no OAuth extraction, no cross-provider fallback, no
provider-native execution, no quota burn for Antigravity discovery (ask
first). Unrelated refactors forbidden; Reaudit-6 fixes preserved.

## 12. Self-review (spec audit, fixed inline)

- Contradictions: none — §0.1 (no Codex declaration channel) is
  consistently reflected in §3.1, §4, §9; the old marker is deleted, not
  redefined.
- Placeholders: none — all file paths, key shapes, TTL/bound constants,
  and proof markers are concrete.
- Ambiguous ownership: resolved — bridge/MCP code carries bytes only;
  Qoder executes; `success:true` with Qoder output is explicitly allowed.
- Fake continuation: banned in three places (§3.1 steps 3–5, §10).
- Cross-request leakage: broker key (§2.1) + transport (§6) + adversarial
  tests (§7).
- Provider-native paths: approval auto-decline retained; MCP handlers
  await-only; native Antigravity tools denied.
