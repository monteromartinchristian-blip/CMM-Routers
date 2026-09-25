# CMM Code Router — Final Independent Audit

**Date:** 2026-09-22
**Audited HEAD:** `4a9f03fc0da8247668e2c39ee236ea0ee7843efa`
**Hardening baseline:** `58652381f3aecf97fbc387f253bb724716a19b1a`
**Bundle SHA-256:** `67c33f1d21d3bb0a3734bc6afc1917b333057038178bd2859f58ab5c97aaa791`

## Executive verdict

The architecture remains **genuinely harness-agnostic**. No branded harness
identity is required by the core for authorization, broker correlation, model
routing, or client metadata.

That part is accepted:

```text
CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE
```

The final protocol-hardening pass also fixes several earlier findings correctly:

- Anthropic non-streaming malformed tool arguments no longer become `{}`;
- Anthropic streaming buffers tool arguments before opening a `tool_use`;
- `toolResultStatus` exists canonically;
- namespace/hosted/unknown declaration classes remain fail-closed;
- protocol-scoped `x_cmm` exists;
- Anthropic controls/auth are explicit rather than silently implied.

However, **the core is not ready for formal audit closure yet**.

Direct inspection found two high-severity correctness gaps and two additional
truthfulness/validation gaps that the final evidence and security audit do not
catch.

```text
CMM_CODE_ROUTER_CORE=AUDIT_NOT_CLOSED
PROTOCOL_EXTENSIBILITY=PARTIAL
FINAL_CLOSURE_READY=NO
```

The remaining work is narrow. It does not require any harness-specific logic.

---

# 1. Provenance

The supplied archive is for:

```text
branch = feature/cmm-code-router-client-agnostic
HEAD   = 4a9f03fc0da8247668e2c39ee236ea0ee7843efa
base   = 58652381f3aecf97fbc387f253bb724716a19b1a
range  = 7 commits / 26 changed files
```

The tarball SHA-256 independently recalculates to:

`67c33f1d21d3bb0a3734bc6afc1917b333057038178bd2859f58ab5c97aaa791`

which matches the build report.

The bundle contains committed tracked state only.

---

# 2. Accepted architectural results

## 2.1 Harness neutrality — PASS

`src/core` contains no Qoder/Hermes/Claude Code/DeepSeek/Cline/Roo/Codex-client
taxonomy.

Authentication remains profile-based (`cmmchat` / `code`) and optional client
metadata remains diagnostic only.

No harness name was found to influence:

- authorization;
- model resolution;
- provider routing;
- broker correlation;
- tool capability;
- fallback behavior.

```text
CORE_HARNESS_AGNOSTIC=YES
```

## 2.2 Client-owned tool policy — PASS

Namespace and hosted/provider-side tools remain explicitly unsupported.

The executable provider-facing request remains narrowed to function tools.

No provider-native tool execution was introduced.

```text
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED
```

## 2.3 Anthropic malformed-argument handling — PASS

`src/http/anthropic-messages.ts:562-575` validates accumulated tool arguments
before emitting non-streaming `tool_use`.

`src/http/anthropic-messages.ts:672-724` buffers streaming tool arguments and
validates them before opening a tool block.

This closes the original Anthropic `{}` fabrication defect.

---

# 3. Blocking findings

## F1 — HIGH — OpenAI streaming surfaces still expose malformed tool calls before validation

### Affected code

`src/http/openai-chat.ts:627-654`

The Chat Completions streaming path immediately forwards every provider
`tool_call_delta` to the downstream client:

```text
provider tool_call_delta
  -> data: chat.completion.chunk
  -> executable downstream tool-call fragments
```

There is no `parseToolArguments` / `validateToolCalls` gate in the streaming
branch.

`src/http/openai-responses.ts:472-527` has the same problem. It emits:

- `response.output_item.added`;
- `response.function_call_arguments.delta`;
- `response.function_call_arguments.done`;
- `response.output_item.done`;

without validating the assembled arguments first.

The hardening only added validation to the **non-streaming** branches:

- Chat: `src/http/openai-chat.ts:549-557`
- Responses: `src/http/openai-responses.ts:400-405`

### Why this matters

A provider can emit:

```text
{"text":
```

and a streaming OpenAI-compatible harness receives the function-call fragments
before the Router knows that the payload is invalid.

That directly contradicts the final evidence claim that malformed provider tool
arguments are validated:

> “before any call is surfaced, on Chat Completions, Responses and Anthropic Messages.”

It is true only for:

- non-streaming Chat;
- non-streaming Responses;
- both Anthropic modes.

### Test gap

`tests/http/malformed-tool-arguments.test.ts` covers:

- non-streaming Chat;
- non-streaming Responses;
- non-streaming Anthropic;
- **streaming Anthropic only**.

There is no malformed-argument streaming test for Chat or Responses.

### Security-audit gap

`scripts/security-audit.sh` declares:

```text
MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
```

merely because `validateToolCalls` is present somewhere in each OpenAI file.
It does not prove that every output path passes through it.

### Required fix

Buffer provider tool-call arguments on both OpenAI streaming surfaces until a
complete call can be validated, then emit a valid downstream lifecycle.

If buffering the entire call is undesirable, a protocol-specific design must
still guarantee that an invalid completed call can never be presented as an
executable completed call.

Add tests:

```text
CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS
```

### Current marker

```text
MALFORMED_TOOL_ARGUMENTS_ALL_SURFACES=FAIL
```

---

## F2 — HIGH — Canonical tool-result status leaks as a non-standard field onto an OpenAI upstream wire

### Affected code

`src/providers/command-code/adapter.ts:45-63`

`toUpstreamMessages()` now adds:

```text
tool_result_status
```

to every upstream message carrying canonical status.

The same message array is used by both Command Code wires:

- OpenAI Chat Completions:
  `src/providers/command-code/adapter.ts:242-267`
- Anthropic Messages:
  `src/providers/command-code/adapter.ts:444-464`

For the OpenAI wire, `CommandCodeClient.streamPath()` serializes those messages
directly into the request body:

`src/providers/command-code/client.ts:725-750`

Therefore an Anthropic downstream `tool_result.is_error` routed through a
Command Code model using the OpenAI upstream wire becomes a non-standard
OpenAI message member:

```json
{
  "role": "tool",
  "tool_call_id": "...",
  "content": "...",
  "tool_result_status": "error"
}
```

### Why this matters

The final evidence explicitly says:

> “OpenAI-wire upstreams have no error bit: content is preserved verbatim and the
> status stays canonical/internal. No wire field was invented.”

The implementation does the opposite for Command Code's OpenAI wire.

A strict OpenAI-compatible upstream may reject the unknown field.

### Required fix

Split wire translation:

```text
canonical messages
  -> OpenAI upstream translator
       (no invented tool-result-status field)
  -> Anthropic upstream translator
       (maps status to is_error)
```

Do not make the canonical field disappear; keep it internal when a wire cannot
represent it.

Add a request-capture test proving:

```text
OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT
ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED
```

### Current marker

```text
TOOL_RESULT_STATUS_OPENAI_WIRE_TRUTH=FAIL
```

---

## F3 — MEDIUM/HIGH — `x_cmm.request_controls` is not truthful for the two OpenAI surfaces

### Affected code

`src/core/protocol-capabilities.ts:104-115`

Both OpenAI-family surfaces use the same descriptor:

```text
request_controls:
  max_tokens = supported
  temperature = explicit_unsupported
```

But the implementations differ.

### Responses mismatch

`src/http/openai-responses.ts:321-323` accepts:

```text
max_output_tokens
```

not `max_tokens`.

So `openai_responses.request_controls.max_tokens = supported` is incorrect.

### `temperature` mismatch

Neither:

- `src/http/openai-chat.ts`
- nor `src/http/openai-responses.ts`

contains a rejection path for `temperature`.

Unknown body members are not globally rejected, so `temperature` is currently
accepted and ignored.

That is not:

```text
temperature = explicit_unsupported
```

### Why this matters

This was the whole purpose of protocol-scoped capability truth: a generic client
should be able to trust `x_cmm` without knowing implementation details.

The current descriptor still overclaims.

### Required fix

Use distinct descriptors per protocol:

```text
openai_chat.request_controls.max_tokens
openai_responses.request_controls.max_output_tokens
```

For every advertised `explicit_unsupported` control, the corresponding surface
must actually reject it, or the descriptor must not claim that behavior.

Add tests that send the controls, rather than only inspect the descriptor.

### Current marker

```text
CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=YES
CAPABILITY_PUBLICATION_TRUTHFUL=FAIL
```

---

## F4 — MEDIUM — malformed Anthropic `is_error` values are silently converted to success

### Affected code

`src/http/anthropic-messages.ts:275-313`

The current mapping is effectively:

```text
is_error === true -> error
anything else     -> success
```

There is no validation that a present `is_error` value is boolean.

For example:

```json
{
  "type": "tool_result",
  "tool_use_id": "tu_1",
  "content": "failed",
  "is_error": "yes"
}
```

is accepted and canonicalized as success.

### Why this matters

The hardening was specifically intended to prevent a failed tool result from
becoming indistinguishable from a successful one.

Malformed status metadata should fail closed, not silently downgrade to success.

### Required fix

If `is_error` is present, require:

```text
typeof is_error === boolean
```

Otherwise return a protocol-shaped `invalid_request_error`.

Also validate `tool_use.input` as the structured shape the supported Anthropic
subset promises, instead of accepting arbitrary primitive input and serializing
it into canonical function arguments.

Add:

```text
ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED
ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED
```

---

# 4. Non-blocking design/evidence observation

## D1 — `RouterTool` is extensible, but not a strict TypeScript discriminated union

`src/core/model.ts:57-105`

Function and namespace variants use literal `type` values, but hosted and unknown
variants declare:

```ts
type: string
```

Those overlap the literal values `"function"` and `"namespace"` at the type
level.

Runtime safety is currently maintained by:

```ts
isFunctionTool(tool) =>
  tool.type === "function" && "function" in tool
```

and by boundary policy.

So:

```text
CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
```

is reasonable.

But the stronger wording:

```text
“discriminated union”
```

is not technically exact.

If the project wants a true discriminated union for future namespace/hosted
support, add a separate stable discriminant such as:

```text
kind: function | namespace | hosted | unknown
```

while retaining the original wire `type` independently.

This does not block current security closure by itself.

---

# 5. Test/evidence assessment

The remediation's focused tests are useful, but the two highest-risk gaps are
specifically outside the tested assertions:

1. malformed provider arguments under **OpenAI streaming**;
2. request capture of canonical tool-result status on a **Command Code OpenAI
   upstream wire**.

The new security-audit checks are presence/grep assertions and therefore returned
PASS despite F1.

The bundle intentionally excludes `node_modules`; this independent audit did not
rerun Vitest/typecheck/build locally.

Therefore the reported:

```text
69 files / 361 focused tests PASS
TYPECHECK=PASS
BUILD=PASS
SECURITY_AUDIT=PASS
```

remain implementation-run evidence rather than independently reproduced runtime
evidence.

The static findings above are independent of that limitation.

---

# 6. Final independent markers

```text
AUDITED_HEAD=4a9f03fc0da8247668e2c39ee236ea0ee7843efa

CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

OPENAI_CHAT_NONSTREAM_MALFORMED_ARGS=FAIL_CLOSED
OPENAI_RESPONSES_NONSTREAM_MALFORMED_ARGS=FAIL_CLOSED
ANTHROPIC_NONSTREAM_MALFORMED_ARGS=FAIL_CLOSED
ANTHROPIC_STREAM_MALFORMED_ARGS=FAIL_CLOSED

OPENAI_CHAT_STREAM_MALFORMED_ARGS=NOT_FAIL_CLOSED
OPENAI_RESPONSES_STREAM_MALFORMED_ARGS=NOT_FAIL_CLOSED

TOOL_RESULT_STATUS_CANONICAL=YES
ANTHROPIC_UPSTREAM_ERROR_BIT=PRESERVED
OPENAI_UPSTREAM_STATUS_INTERNAL_ONLY=NO

CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
STRICT_TYPESCRIPT_DISCRIMINATED_UNION=NO
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED

CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=YES
CAPABILITY_PUBLICATION_TRUTHFUL=NO

ANTHROPIC_REQUEST_CONTROLS_TRUTHFUL=YES
ANTHROPIC_AUTH_WIRE_TRUTHFUL=YES
ANTHROPIC_TOOL_RESULT_STATUS_VALIDATION=PARTIAL

CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES

CMM_CODE_ROUTER_CORE=AUDIT_NOT_CLOSED
FINAL_CLOSURE_READY=NO
NEXT=NARROW_FINAL_CLOSURE_FIX
```

---

# 7. Smallest safe final closure

Do not change the architecture.

One narrow pass is enough:

1. buffer + validate streaming OpenAI function-call arguments before completing
   executable calls;
2. separate Command Code OpenAI/Anthropic message translation so
   `tool_result_status` never appears on OpenAI wire;
3. make OpenAI Chat/Responses request-control publication match real field names
   and actual rejection behavior;
4. validate Anthropic `is_error` and `tool_use.input`;
5. add runtime tests for exactly those paths;
6. strengthen `security-audit.sh` so malformed-argument coverage is behavioral,
   not merely grep-presence based.

After that, regenerate one final committed-state tarball for the true closing
audit.
