# CMM Code Router — True Final Independent Audit

**Date:** 2026-09-22
**Audited HEAD:** `8671299323a329a7f913621584d8f398c36915bd`
**Last independently audited production HEAD:** `4a9f03fc0da8247668e2c39ee236ea0ee7843efa`
**Actual narrow-closure base:** `4e0c5465b28b33685282506ffa40af04482c2854`
**Bundle SHA-256:** `4fadd4ecb530c7d0332577c1ad5e6f06d0bcfa6501b7d08091b1ed1c8d96cd47`

## Executive verdict

The narrow closure fixes the four blocking findings from the previous independent
audit without reopening the architecture or introducing a harness-specific path.

The CMM Code Router core is therefore **audit-closed for the agreed core and
protocol invariants**.

```text
CMM_CODE_ROUTER_CORE=AUDIT_CLOSED
FINAL_CORE_CLOSURE=PASS

CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

PROTOCOL_EXTENSIBILITY_CORE=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE

NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
```

This does **not** mean every possible downstream capability is implemented.

The intentionally unsupported capabilities remain explicit:

```text
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
ANTHROPIC_MESSAGES_COMPAT=PARTIAL_WITH_EXPLICIT_TRUTH
```

Those are compatibility/product-expansion items, not reasons to keep modifying the
core.

---

## 1. Provenance and integrity

The supplied committed-state bundle identifies:

```text
BRANCH=feature/cmm-code-router-client-agnostic
HEAD=8671299323a329a7f913621584d8f398c36915bd
AUDITED_BASE=4a9f03fc0da8247668e2c39ee236ea0ee7843efa
ACTUAL_CLOSURE_BASE=4e0c5465b28b33685282506ffa40af04482c2854
NARROW_CLOSURE_COMMIT_COUNT=8
NARROW_CLOSURE_CHANGED_FILE_COUNT=21
WORKTREE_CLEAN=YES
```

The audit tarball independently hashes to:

`4fadd4ecb530c7d0332577c1ad5e6f06d0bcfa6501b7d08091b1ed1c8d96cd47`

which matches the builder's recorded tarball hash.

The narrow closure is linear:

1. `ff099cb` — streaming malformed-argument fail-closed
2. `479c1b3` — per-wire tool-result translation
3. `b2ddc27` — cancellation fixture adapted to validated buffering
4. `ead8071` — request-control truth/enforcement
5. `a853838` — Anthropic tool shape validation
6. `d8581b0` — strict canonical tool discriminant
7. `5188bdf` — security-audit invariants
8. `8671299` — closure evidence

No provider capability promotion appears in the supplied closure-range metadata.

---

# 2. Previous blocking finding F1 — CLOSED

## Streaming OpenAI tool arguments now fail closed

### Chat Completions

`src/http/openai-chat.ts:621-715`

`tool_call_delta` fragments are no longer sent directly downstream. They are
accumulated in `streamedCalls`.

On `completed`:

```text
streamed calls
 -> validateToolArguments(...)
 -> either protocol error
 -> or emit validated tool_calls + terminal finish reason
```

The malformed path emits an error and exits before any completed executable
`tool_calls` lifecycle is sent.

### Responses

`src/http/openai-responses.ts:477-579`

The same invariant now exists for the Responses surface:

```text
pending function-call fragments
 -> validateToolArguments(...)
 -> response.failed on invalid JSON
 -> OR output_item/function_call lifecycle + response.completed
```

A malformed call cannot reach `response.output_item.done` or
`response.completed`.

### Tests

`tests/http/streaming-malformed-tool-arguments.test.ts`

The closure adds direct behavioral tests for both streaming surfaces, including a
valid fragmented call and malformed fragmented call.

### Verdict

```text
CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS
VALID_STREAM_TOOL_ARGUMENTS_PRESERVED=PASS
```

---

# 3. Previous blocking finding F2 — CLOSED

## Canonical tool-result status no longer leaks onto OpenAI upstream wire

`src/providers/command-code/adapter.ts:45-75`

Message translation is now explicitly wire-specific.

For the OpenAI-compatible Command Code path:

```text
canonical toolResultStatus
 -> remains internal
 -> no tool_result_status field emitted
 -> no is_error field emitted
```

For the Anthropic Command Code path:

```text
canonical toolResultStatus
 -> internal tool_result_status bridge metadata
 -> buildAnthropicRequestBody(...)
 -> Anthropic tool_result.is_error
```

`src/providers/command-code/client.ts:1026-1048` performs the final native
Anthropic conversion.

### Captured-wire tests

`tests/providers/command-code-wire-tool-result-status.test.ts`

The tests inspect the actual serialized request bodies and assert:

```text
OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT
OPENAI_UPSTREAM_TOOL_RESULT_CONTENT_PRESERVED=PASS
ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED
```

The previously invented OpenAI field is gone.

---

# 4. Previous blocking finding F3 — CLOSED

## `x_cmm.request_controls` now derives from enforcement truth

`src/core/request-controls.ts`

The closure establishes a single source of truth for downstream controls.

### Chat Completions

Supported:

```text
max_tokens
```

Explicitly refused when present:

```text
temperature
top_p
top_k
stop
stop_sequences
presence_penalty
frequency_penalty
logit_bias
n
seed
logprobs
top_logprobs
```

### Responses

Supported:

```text
max_output_tokens
```

`max_tokens` is explicitly rejected with a hint to use `max_output_tokens`.

The same unsupported semantic controls are rejected rather than silently ignored.

### Capability publication

`src/core/protocol-capabilities.ts:113-157`

Each protocol surface gets its own `request_controls` descriptor derived from the
same enforced lists.

The earlier shared/OpenAI-wide mismatch is gone.

### Behavioral tests

`tests/http/openai-request-controls.test.ts`

The tests send real HTTP requests and verify both enforcement and publication;
they do not merely inspect a constant.

### Verdict

```text
OPENAI_CHAT_REQUEST_CONTROL_TRUTH=PASS
OPENAI_RESPONSES_REQUEST_CONTROL_TRUTH=PASS
OPENAI_RESPONSES_MAX_OUTPUT_TOKENS_TRUTH=PASS
OPENAI_TEMPERATURE_NOT_SILENTLY_IGNORED=PASS
CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=PASS
CAPABILITY_PUBLICATION_TRUTHFUL=PASS
```

---

# 5. Previous blocking finding F4 — CLOSED

## Anthropic tool-result and tool-use shapes now fail closed

`src/http/anthropic-messages.ts:248-323`

### `tool_result.is_error`

When present, it must be a boolean.

Anything else returns an `invalid_request` path before provider invocation.

There is no longer a malformed-value → success downgrade.

### `tool_use.input`

The supported subset requires a structured object.

Primitives and arrays are rejected instead of being serialized into canonical
function arguments.

An absent input retains the documented empty-object default.

### Tests

`tests/http/anthropic-tool-shape-validation.test.ts`

The closure tests malformed `is_error`, primitive/array inputs, structured input,
and the absent-input default.

### Verdict

```text
ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED
ANTHROPIC_TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS
ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED
```

---

# 6. Optional D1 — CLOSED

## Canonical tool declaration union now has a stable discriminant

`src/core/model.ts`

Every `RouterTool` variant now carries a closed `kind`:

```text
function
namespace
hosted
unknown
```

`isFunctionTool()` narrows on `kind`.

The original wire `type` remains independently available, so future hosted or
unknown types do not need to pretend to be a known wire type.

Provider-facing execution remains narrowed to:

```ts
RouterRequest.tools: RouterFunctionTool[]
```

so making the algebra representable has not enabled unsupported execution.

### Verdict

```text
CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
STRICT_TYPESCRIPT_DISCRIMINATED_UNION=YES
UNSUPPORTED_TOOL_NEVER_REACHES_PROVIDER=PASS
```

---

# 7. Harness-agnostic architecture — FINAL PASS

The current `src/core` contains no downstream-harness taxonomy.

No Qoder/Hermes/Claude Code/DeepSeek/Cline/Roo/Codex-client identity is required
by core authorization, model routing, broker correlation, or canonical capability
logic.

The security identity remains the authenticated Router profile:

```text
cmmchat -> CHAT_ONLY
code    -> eligible for model-verified CHAT_AND_TOOLS
```

Optional client labels remain observability metadata only.

Therefore a future harness does **not** need a core enum or authorization branch.
It only needs to speak a supported downstream protocol/capability set.

```text
CORE_HARNESS_AGNOSTIC=YES
HARNESS_SPECIFIC_AUTHORIZATION=NONE
HARNESS_SPECIFIC_MODEL_ROUTING=NONE
HARNESS_SPECIFIC_BROKER_LOGIC=NONE
```

---

# 8. Declared limits that do NOT block core closure

## Namespace tools

Representable/classifiable, but deliberately not executable.

```text
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
```

A future implementation still needs a generic, reversible, collision-safe design.

## Hosted/provider-side tools

Deliberately unsupported while the security invariant is:

```text
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
```

Therefore:

```text
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
```

is the correct current product behavior.

## Anthropic Messages

The protocol adapter is an explicitly declared subset.

Unrepresented generation controls are rejected rather than silently ignored.
Real-client verification remains a compatibility gate.

Therefore:

```text
ANTHROPIC_MESSAGES_COMPAT=PARTIAL_WITH_EXPLICIT_TRUTH
```

is acceptable and does not make the core harness-specific.

## Streaming tool fragments

For tool calls, CMM now prioritizes fail-closed validation over exposing partial
argument fragments.

A valid tool payload may therefore arrive to the downstream client as one
validated argument payload rather than multiple provider-native fragments.

That is a deliberate protocol contract choice and is documented.

---

# 9. Verification evidence assessment

The implementation evidence reports:

```text
Broad battery: 134 files / 723 tests PASS
TYPECHECK=PASS
BUILD=PASS
SECURITY_AUDIT=PASS
git diff --check=clean

Full suite:
8 failed files
18 failed tests
961 passed
25 skipped
1004 total
```

The remaining full-suite failures are classified as the same environmental
families already seen before this closure:

- unavailable local `codex`/`agy` binaries;
- 5-second environment/load timeouts;
- publication git/remote infrastructure;
- one Keychain/runtime-under-load family that passes in isolation.

The closure reports no timeout inflation, no skipped test added to hide a failure,
and no weakened assertion.

The committed bundle intentionally excludes `node_modules`, so this independent
audit could not rerun Vitest/typecheck/build inside the audit environment.
Accordingly:

- source/diff/invariant review is independently verified;
- runtime test counts remain implementation-run evidence.

That limitation does not reveal a source-level contradiction in the claimed
closure.

---

# 10. Non-blocking maintenance observations

These do **not** reopen the core closure.

### A. Supported token controls could gain stricter type validation

Chat only forwards `max_tokens` when it is numeric, and Responses only forwards
`max_output_tokens` when it is numeric. A malformed type is therefore currently
outside the explicitly tested control-truth cases.

A future API-hardening pass may reject malformed supported-control values
explicitly.

This is input-validation polish, not a harness/core architectural defect.

### B. Anthropic role/block placement could be made stricter

The current subset validates block shapes but does not fully enforce every native
Anthropic role/block placement rule (for example, native clients normally place
`tool_use` in assistant content and `tool_result` in user content).

A later protocol-fidelity pass can tighten that without changing canonical
architecture.

### C. Usage diagnostics record provider completion before boundary post-validation

`trackProviderStream()` records provider `completed` as success before the HTTP
surface performs its final tool-argument validation.

Thus a provider can be recorded as successfully completed while the downstream
surface subsequently returns a protocol error.

This affects observability semantics, not tool execution or fallback safety.

### D. Builder report self-hash is computed before its final lines are appended

The tarball SHA is independently correct and matches.

The text report's own embedded `REPORT_SHA256` is not a hash of the final file
because the builder computes it immediately before appending the last report
lines.

This is audit-artifact plumbing only, not Router code.

None of A–D changes the final core verdict.

---

# 11. Final markers

```text
AUDITED_HEAD=8671299323a329a7f913621584d8f398c36915bd

CMM_CODE_ROUTER_CORE=AUDIT_CLOSED
FINAL_CORE_CLOSURE=PASS

CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS

OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT
ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED

OPENAI_CHAT_REQUEST_CONTROL_TRUTH=PASS
OPENAI_RESPONSES_REQUEST_CONTROL_TRUTH=PASS
CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=PASS
CAPABILITY_PUBLICATION_TRUTHFUL=PASS

ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED
ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED

CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
STRICT_TYPESCRIPT_DISCRIMINATED_UNION=YES

NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
ANTHROPIC_MESSAGES_COMPAT=PARTIAL_WITH_EXPLICIT_TRUTH

CMMCHAT_CHAT_ONLY=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE

NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
TRACKED_SECRETS=NONE
LOOPBACK_ONLY=YES

TYPECHECK=PASS_BY_IMPLEMENTATION_EVIDENCE
BUILD=PASS_BY_IMPLEMENTATION_EVIDENCE
SECURITY_AUDIT=PASS_BY_IMPLEMENTATION_EVIDENCE
FULL_SUITE=FAIL_WITH_CLASSIFIED_ENVIRONMENTAL_EVIDENCE

LIVE_PROVIDER_INFERENCE_RUN=NO
PUSH_PERFORMED=NO
MERGE_PERFORMED=NO
PUBLICATION_PERFORMED=NO

NEXT=COMPATIBILITY_VERIFICATION_WITHOUT_CORE_REDESIGN
```

## Closing decision

Do not reopen the CMM Code Router core merely to verify a new downstream client.

From this point forward, Qoder, Claude Code, DeepSeek Harness, Hermes, Codex and
future harnesses are **compatibility targets** against the supported protocol and
capability surfaces.

A client-specific failure should first be classified as:

1. configuration issue;
2. existing protocol capability mismatch;
3. genuinely new protocol capability worth adding generically.

Only case 3 should justify a new core capability design, and it must remain
brand-independent.
