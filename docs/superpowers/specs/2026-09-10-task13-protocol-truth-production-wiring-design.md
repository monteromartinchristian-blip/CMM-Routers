# Task 13 — Protocol Truth & Production Wiring (Delta Design)

**Date:** 2026-09-10
**Status:** Approved direction (human-approved 2026-09-10)
**Supersedes (where conflicting):** `2026-09-10-deferred-tool-broker-design.md`
**Authoritative input:** `docs/audits/2026-09-10-independent-task13-completion-reaudit-b891af3.md`

This is a **delta** design. It does not reopen the Router remediations closed in
earlier reaudits, and it does not reopen the product requirement. It corrects the
specific protocol-truth errors and production-integration gaps the newest
independent reaudit identified.

---

## 0. Product requirement (unchanged, non-negotiable)

| Consumer | chatgpt | claude | google | command-code |
| --- | --- | --- | --- | --- |
| CMMChat | CHAT_ONLY | CHAT_ONLY | CHAT_ONLY | CHAT_ONLY |
| Qoder | CHAT_AND_TOOLS | CHAT_AND_TOOLS | CHAT_AND_TOOLS | CHAT_AND_TOOLS |

Ownership invariants are unchanged: `PROVIDER_OWNS_REASONING=YES`,
`QODER_OWNS_TOOLS/FILESYSTEM/SHELL/EDITS=YES`,
`ROUTER_EXECUTES_QODER_SIDE_EFFECTS=NO`,
`PROVIDER_NATIVE_*_EXECUTION=NO`. A local bridge transports only; it never runs
the requested side effect. Truthful FAIL is preferable to fake PASS.

---

## 1. Evidence base (installed, re-verified this session)

```text
codex-cli 0.153.4
agy 1.1.28
@anthropic-ai/claude-agent-sdk 0.3.266
```

### 1.1 Codex experimental schema is real (corrects the false blocker)

Generated in a TEMP directory, never overwriting tracked fixtures:

```bash
codex app-server generate-json-schema --experimental \
  --out /tmp/cmm-codex-schema-experimental-0.153.4
```

Observed (exact, from the generated artifacts — not from prose):

```text
v2/ThreadStartParams.json
  dynamicTools: { default: null, type: ["array","null"],
                  items: { $ref: "#/definitions/DynamicToolSpec" } }

definitions/DynamicToolSpec = oneOf:
  FunctionDynamicToolSpec   required: description, inputSchema, name, type="function"
                            optional: deferLoading: boolean
  NamespaceDynamicToolSpec  required: description, name, tools, type="namespace"

v1/InitializeParams.json
  capabilities?: InitializeCapabilities|null
  InitializeCapabilities.experimentalApi: boolean (default false)

DynamicToolCallParams  required: arguments, callId, threadId, tool, turnId  (+ optional namespace)
DynamicToolCallResponse required: contentItems (DynamicToolCallOutputContentItem[]), success
```

Consequences:

- The previous conclusion “0.153.4 has no dynamic-tool declaration channel” is
  **FALSE**. It came from generating the stable-only surface.
- `initialize.params.capabilities.experimentalApi=true` is the required opt-in.
- `item/tool/call` requires `callId`; a missing/empty `callId` is a protocol
  violation and must fail closed — never be replaced by a synthesized id.

### 1.2 `DynamicToolSpec` field mapping (OpenAI/Qoder → Codex)

| Qoder `RouterTool` | Codex `FunctionDynamicToolSpec` |
| --- | --- |
| `function.name` | `name` |
| `function.description` | `description` (required; empty string when absent) |
| `function.parameters` | `inputSchema` (verbatim JSON Schema) |
| — | `type: "function"` |
| — | `deferLoading: false` |

---

## 2. P0 #1 — Codex 0.153.4 experimental dynamic tools

### 2.1 Initialize opt-in

`CodexAdapter.ensureStarted()` sends:

```json
{"jsonrpc":"2.0","id":N,"method":"initialize",
 "params":{"clientInfo":{"name":"cmm-subscription-router",...},
           "capabilities":{"experimentalApi":true}}}
```

### 2.2 Declaration on `thread/start`

`buildThreadStartParams()` gains an optional `dynamicTools: DynamicToolSpec[]`.
The adapter maps `request.tools` and sends them **on the same `thread/start`**
that creates the tool-capable thread. No definitions → no `dynamicTools` field
(never an empty array, which would change wire bytes for text-only turns).

`schema-protocol.ts` `SchemaThreadStartParams` gains the experimental
`dynamicTools?: unknown[] | null` field, and a schema-backed
`SchemaDynamicToolSpec` type mirrors the generated `oneOf`.

### 2.3 Tracked experimental fixture

A separate tracked fixture records the experimental surface so the wire shape is
reviewable without regenerating:

```text
tests/fixtures/generated/codex-experimental-0.153.4/
  ThreadStartParams.dynamicTools.json   (the dynamicTools property only)
  DynamicToolSpec.json                  (the oneOf)
  InitializeCapabilities.json
  DynamicToolCallParams.json
  DynamicToolCallResponse.json
  PROVENANCE.json                       (exact command + version)
```

The stable tracked fixture set is left untouched.

### 2.4 Strict fake app-server

A fake app-server used by the new tests **rejects** `thread/start` unless:

1. a prior `initialize` carried `capabilities.experimentalApi === true`;
2. `params.dynamicTools` is present;
3. each spec is `type:"function"` with matching `name`;
4. `description` matches where supplied;
5. `inputSchema` is structurally equal to the Qoder schema;
6. `deferLoading === false`.

If any check fails the fake returns a JSON-RPC error (the run fails closed).
**No test may synthesize `item/tool/call` unless the fake first observed a valid
declaration.** This is enforced by construction: the fake's turn/start handler
only schedules the tool call after a successful declaration validation.

### 2.5 Fail-closed protocol validation

In the adapter's `item/tool/call` handling:

| Condition | Result |
| --- | --- |
| `params.callId` missing/empty | `provider_protocol_error` (no fabrication) |
| `params.tool` missing/empty | `provider_protocol_error` |
| `params.threadId` missing | `provider_protocol_error` |
| `params.turnId` missing | `provider_protocol_error` |

The error is yielded as an `error` event and the pending wire request is answered
`{success:false, contentItems:[]}` so the provider turn fails closed instead of
hanging. `CODEX_PROVIDER_CALL_ID_FABRICATION=NONE`.

### 2.6 Preserved (do not regress)

`item/tool/call` → hold ORIGINAL JSON-RPC request → surface to Qoder → Qoder
executes → answer ORIGINAL request with `success:true` → same thread → same turn
→ provider continues. No `success:false` normal path, no new thread, no textual
fake-history reconstruction.

---

## 3. P0 #2 — Broker becomes production state

### 3.1 Composition

One Router-owned `DeferredToolBroker` is created in `createProductionRegistry()`
(the composition root) and **explicitly injected** into adapters that need
cross-request pending state. No per-adapter fake brokers.

### 3.2 Public vs provider-internal tool identity (chosen model)

Qoder's standard OpenAI follow-up gives the Router only `tool_call_id` plus
ordinary message history. There is no proven, standard way for Qoder to echo a
custom correlation field. Therefore:

- The Router issues a **globally unique public `tool_call_id`**
  (`cmm_<provider>_<random>`), exposed to Qoder on `tool_call_delta`.
- The broker stores a lossless mapping:

  ```text
  publicToolCallId → { provider, providerSession (threadId), providerTurn (turnId),
                       providerCallId, wireRequestId }
  ```

- Qoder returns the public id. The Router resolves the exact provider-internal
  call and answers the original wire request using the **provider's own**
  `callId` where the native protocol requires it.

This is documented explicitly because the reaudit forbids depending on unknown
response fields being echoed by Qoder, and forbids keying identity by tool name,
callId-only, or arguments-only.

### 3.3 Broker properties (all required in production)

bounded (`maxPending`), TTL-limited (`defaultTtlMs`), one-shot, cancellable,
provider-death-cleanable, cross-request isolated, cross-consumer isolated,
duplicate-safe, late-result-safe. No tool argument/result content is retained
after handoff.

### 3.4 Cleanup from real production paths

`ACTIVE_PENDING_TOOLS=0` for the relevant scope after: HTTP disconnect, Qoder
cancellation, provider cancellation, provider subprocess death, provider session
termination, TTL expiry, successful completion. `cancelScope` must never cancel
unrelated concurrent runs.

### 3.5 Adversarial proof (deterministic)

same provider callId in two simultaneous sessions; same tool name in two
sessions; identical arguments in two sessions; guessed tool id; duplicate result;
late result; wrong consumer; wrong provider; closed provider session.

---

## 4. P0 #3/#4 — Claude and Antigravity real adapter wiring

### 4.1 The external-MCP reality

An external stdio MCP process cannot call an in-memory JavaScript callback in the
Router. The bridge-control transport must be an explicit local IPC between the
Router and the bridge process. `MCP stdio` is provider-facing; `bridge-control
IPC` is Router-facing. The two concepts stay separate.

### 4.2 Bridge-control IPC security model

- Unix domain socket under a per-session ephemeral directory
  (`os.tmpdir()/cmm-bridge-<pid>-<random>/bridge.sock`), created with mode `0700`
  on the directory and `0600` on the socket.
- Per-session unguessable token (`crypto.randomBytes(32).toString("hex")`)
  presented on connect; the bridge rejects any request without it.
- No Internet binding; no `0.0.0.0`; loopback/Unix-socket only.
- No credential reuse: the bridge receives no provider credential.
- Cleanup on session death: socket + directory removed; bridge process killed.
- Arguments and results are never logged.

A loopback ephemeral TCP control channel is a fallback only if Unix sockets are
unavailable, with equivalent token auth and `127.0.0.1`-only binding.

### 4.3 Claude lifecycle

Chosen architecture is decided by installed SDK 0.3.266 inspection, not by prior
prose. The bridge exposes an external stdio MCP server (`Options.mcpServers`)
whose tool handler parks the request into the broker over the control IPC, waits
for Qoder's result, then returns it, allowing the **same SDK query/run** to
continue. `PreToolUse`/`permissionDecision:"defer"` is only used if it is the
only protocol-correct path; if it intercepts before the MCP `tools/call` reaches
the bridge, the tool-use id identity is modelled separately from the MCP request
id. Claude native shell/file/edit tools remain disabled. Correlation is exact;
ambiguity fails closed; no name-only or args-only matching.

### 4.4 Antigravity lifecycle

`agy` runs with a request/session-scoped MCP configuration where supported;
persistent `agy mcp add` registration is idempotent, CMM-owned, secret-free, and
documented. The agy child run stays alive across the split HTTP interaction; no
new agy run is spawned to fake continuation. Native `run_command`,
`replace_file_content`, `write_to_file` are never used for Qoder-owned tools;
`--dangerously-skip-permissions` is never used.

### 4.5 Truthful reporting rule

Claude/Antigravity are only reported `CHAT_AND_TOOLS` after the deterministic
production-path proof passes. If the bridge cannot correlate safely, the stop
condition applies and the provider is reported FAIL with exact evidence.

---

## 5. P1 — Command Code wires

### 5.1 OpenAI wire (fix the concrete client)

`CommandCodeClient.streamChatCompletion()` options and request body are extended
to actually serialize `tool_choice` and `parallel_tool_calls`. The strict test
inspects the **HTTP JSON body emitted by the client**, not the adapter options
object. Preserved: `assistant.tool_calls` history, exact `tool_call_id`,
upstream `index`-based fragment correlation, interleaved parallel fragments,
GOAT spend protection.

### 5.2 Anthropic wire (implement tools)

`/provider/v1/messages` follows the Anthropic Messages schema, which natively
supports client-defined tools. Implement:

- request: Qoder tools → `tools[]`;
- streaming: `content_block_start` (`tool_use`), `content_block_delta`
  (`input_json_delta`) → Router `tool_call_delta`;
- continuation: Qoder result → `tool_result` with `tool_use_id`;
- exact id preservation/correlation; strict fake upstream rejects malformed
  continuation. No native execution (`COMMAND_CODE_NATIVE_TOOL_EXECUTION=NONE`).

---

## 6. P1 — Responses function-call lifecycle

- Non-streaming output emits canonical `function_call` with **both** the output
  item `id` and a distinct `call_id`. Tests assert exact keys — never
  `call_id ?? id`.
- Streaming emits the canonical sequence with correct `output_index`, `item_id`,
  `call_id`, `name`, `arguments`:
  `response.output_item.added`, `response.function_call_arguments.delta`,
  `response.function_call_arguments.done`, `response.output_item.done`,
  `response.completed`.
- Input parsing of `function_call` / `function_call_output` is preserved.
- Text streaming must not regress.

---

## 7. Policy invariants

- `tool_choice` and `parallel_tool_calls` are forwarded natively where the wire
  supports it (Command Code OpenAI/Anthropic).
- Where Codex cannot faithfully represent `tool_choice="required"`, a forced
  named function, or `parallel_tool_calls=false`, the Router **rejects the
  constraint consistently** on both `/v1/chat/completions` and `/v1/responses`.
  It never silently ignores it.
- `SILENT_TOOL_CHOICE_DROP=NONE`, `SILENT_PARALLEL_TOOL_POLICY_DROP=NONE`.

---

## 8. Tool-result bound, malformed arguments, logging hygiene

- Default maximum tool-result payload **1 MiB**, enforced before the result
  enters provider continuation, through the real adapter/broker path. An
  oversize result fails closed and never reaches the provider.
- Malformed/incomplete JSON at the point a complete tool call is expected fails
  closed **before** being surfaced as an executable Qoder call. Legal streaming
  fragments are not rejected before assembly.
- Sentinel secrets in tool arguments and tool results must be absent from all
  telemetry/log sinks after traversing the real HTTP/provider/broker path.

---

## 9. Provisioning

Add the local Keychain provisioning path for the Qoder bearer:

```bash
security add-generic-password -s cmm-subscription-router -a qoder-bearer -w
```

Update installation docs, installer/setup scripts, and launchd reproducibility
tests. No tracked secret value; the token is never echoed.

---

## 10. Regression protection

All previously closed work is preserved (reaudit-6 protocol fixes, Codex
malformed-frame/notification/cancel isolation, preflight/schema equivalence,
launchd fail-closed, Claude profile/env isolation, Command Code abort/timeout
protection, PAYG poison guards, loopback-only binding, consumer capability
policy, CMMChat CHAT_ONLY, logging hygiene). No unrelated refactors.

---

## 11. Known limitations (truthful)

Deterministic wiring for a provider is claimed `CHAT_AND_TOOLS` only after its
production-path proof passes. Any provider whose bridge/IPC wiring is not
demonstrably complete in this pass is reported FAIL/BLOCKED for the Qoder
consumer — never silently downgraded to CHAT_ONLY. `LIVE_TOOL_ACCEPTANCE_RUN=NO`
in this phase.
