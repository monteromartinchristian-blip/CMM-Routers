# CMM Code Router — Independent Protocol-Extensibility Audit

**Date:** 2026-09-22
**Audited HEAD:** `7c5e68ba64b695b718c70b3f3bada1c399f349f8`
**Remediation baseline:** `27650ab5d3bf319c99cb51810160ec024f9b1395`
**Bundle SHA-256:** `83586cc985bd2c39952737028e1c0d51ec457d4d2b87faaf260091310c15ad23`

## Executive verdict

The remediation successfully makes the **security and routing core harness-agnostic**.

The following are supported by direct static inspection:

```text
CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE
HARNESS_SPECIFIC_AUTHORIZATION=NONE_FOUND
HARNESS_SPECIFIC_MODEL_ROUTING=NONE_FOUND
HARNESS_SPECIFIC_BROKER_LOGIC=NONE_FOUND
```

However, the remediation **does not yet close protocol extensibility completely**.

The new Anthropic Messages surface is a useful protocol adapter and the new tool-kind classifier is fail-closed, but two important claims are currently stronger than the implementation justifies:

1. the canonical Router tool algebra is still structurally function-only;
2. the Anthropic Messages surface is a tested subset, not yet a fully faithful protocol adapter.

Therefore the independent verdict is:

```text
CORE_HARNESS_AGNOSTIC=YES
PROTOCOL_EXTENSIBILITY=PARTIAL
ANTHROPIC_MESSAGES_COMPAT=PARTIAL
CAPABILITY_PUBLICATION_TRUTHFUL=PARTIAL
REMEDIATION_READY_FOR_FINAL_CLOSURE=NO
```

The remaining work is narrow and protocol-centric. It does not require reintroducing any harness brand into the core.

---

## 1. Provenance and range integrity

The supplied bundle reports and contains:

- branch `feature/cmm-code-router-client-agnostic`;
- HEAD `7c5e68ba64b695b718c70b3f3bada1c399f349f8`;
- clean worktree;
- baseline `27650ab...` as ancestor;
- 9 remediation commits;
- 39 changed files.

The tarball SHA-256 independently recalculates to:

`83586cc985bd2c39952737028e1c0d51ec457d4d2b87faaf260091310c15ad23`

matching the build report.

No provider capability promotion appears in the supplied remediation range metadata.

---

# 2. What is now genuinely correct

## 2.1 Core client metadata is harness-agnostic — PASS

`src/core/client-identity.ts`

The old closed harness taxonomy is gone.

The core now contains only:

```text
CLIENT_LABEL_HEADER = "x-cmm-client"
CLIENT_LABEL_MAX_LENGTH = 64
normalizeClientLabel(...)
```

An arbitrary future label is accepted as bounded, sanitized opaque diagnostics.

There is no list containing Qoder, Hermes, Codex, Claude Code, DeepSeek Harness,
Cline, Roo, etc.

This is the correct architecture.

The label is not used as an authorization or routing input.

### Marker

```text
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
```

---

## 2.2 Authentication remains profile-based — PASS

`src/http/identity.ts`

Security identity remains:

```text
cmmchat profile
code profile
```

The canonical Code Router bearer and legacy Qoder bearer both map to the Code
profile.

The legacy bearer can supply a historical diagnostic label, but that label is
not the authorization primitive.

CMMChat/Code secret collisions remain fail-closed.

### Marker

```text
AUTH_HARNESS_AGNOSTIC=YES
```

---

## 2.3 Broker and model routing remain harness-neutral — PASS

The remediation does not reintroduce a client identity into broker correlation or
model selection.

The prior client-neutral broker and exact model-resolution architecture remain
intact.

No harness-name routing branch was found in the current core.

### Markers

```text
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
```

---

## 2.4 Unsupported tool classes are now explicit and fail closed — PASS

`src/core/tool-kind.ts`

The Router now classifies declaration wire types as:

```text
function
namespace
hosted
unknown
```

with policy:

```text
function  -> SUPPORTED
namespace -> EXPLICIT_UNSUPPORTED
hosted    -> EXPLICIT_UNSUPPORTED
unknown   -> FAIL_CLOSED
```

Known hosted types include `web_search`, `file_search`, `code_interpreter`,
`computer_use_preview`, `mcp`, `local_shell`, etc.

This is much better than silently dropping unsupported declarations.

The error is capability-centric and does not name a harness.

### Markers

```text
FUNCTION_TOOL_KIND=SUPPORTED
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED
```

---

## 2.5 Capability discovery is materially better — PASS WITH CAVEAT

`src/core/protocol-capabilities.ts`
`src/http/server.ts`

`x_cmm.code_router` is retained and richer data is published additively:

- protocol surface availability;
- function/namespace/hosted tool status;
- tool-choice support;
- parallel-tool-call support;
- streaming;
- cancellation;
- developer-role support.

Unknown model capability still publishes no `x_cmm`, avoiding promotion.

`/v1/models` also returns the same entries through both `data` and additive
`models` keys, without branching on harness identity.

This is a good protocol-centric direction.

A caveat is documented in Finding P4 below: several capability fields are global
rather than per-protocol, so the descriptor cannot yet faithfully express
surface-specific differences.

---

## 2.6 Legacy aliases are semantically isolated in TypeScript — PASS WITH SCOPE CAVEAT

`src/compat/legacy-identifiers.ts`

The persisted historical values are centralized behind semantic TypeScript
constants, including:

- legacy bearer env/keychain account;
- Antigravity MCP server and ACL;
- bridge server name;
- Claude MCP prefix;
- Qoder provider id;
- smoke marker.

This removes the historical product identity from current TypeScript semantics.

The values themselves remain unchanged, which is correct for compatibility.

A documentation/evidence overclaim remains: raw legacy literals intentionally
still exist in scripts and launchd templates. See Finding E1.

---

# 3. Blocking findings before final protocol-extensibility closure

## P1 — HIGH — Anthropic non-streaming tool calls silently fabricate `{}` on malformed arguments

**File:** `src/http/anthropic-messages.ts`
**Area:** non-streaming response aggregation, around the tool-use body construction.

The adapter accumulates provider `argumentsDelta`, then does:

```ts
try {
  input = JSON.parse(call.args);
} catch {
  input = {};
}
```

This is not fail-closed.

If a provider emits malformed tool JSON, the Router changes:

```text
malformed provider arguments
```

into:

```json
{}
```

and sends a syntactically valid `tool_use` to the client.

That can cause the client/harness to execute a tool with fabricated parameters.

This conflicts with the architecture's general rule of refusing to guess instead
of silently changing semantics.

### Required remediation

Do not substitute `{}`.

Instead:

- return a protocol-shaped error; or
- terminate the streamed/non-streamed response with an explicit malformed-tool
  error before the client executes it.

Add a deterministic test proving malformed arguments cannot become executable.

### Required marker

```text
MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
```

---

## P2 — HIGH — Anthropic `tool_result.is_error` is parsed in the wire type but discarded semantically

**File:** `src/http/anthropic-messages.ts`
**Related core:** `src/core/model.ts`

The Anthropic wire type declares:

```ts
is_error?: boolean
```

but `parseAnthropicRequest()` records only:

```text
tool_use_id
content
```

and turns the result into:

```ts
{ role: "tool", content, toolCallId }
```

The error/success status is lost.

This means a client can report a failed tool execution and the Router will
continue with no canonical indication that the tool failed.

This is a real protocol-semantic loss, not a cosmetic omission.

### Architectural implication

The canonical `RouterMessage` has no generic tool-result status field.

A protocol-centric fix should introduce something equivalent to:

```text
toolResultStatus?: success | error
```

or another canonical representation that OpenAI/Anthropic adapters can map
without depending on a harness name.

### Required remediation

- preserve Anthropic `is_error`;
- add a canonical tool-result status if needed;
- map it explicitly on provider wires that can represent it;
- if an upstream path cannot represent the status, fail closed or document the
  precise loss rather than silently deleting it.

### Required marker

```text
TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS
```

---

## P3 — MEDIUM/HIGH — The claimed “extensible internal tool algebra” is not actually implemented

**Files:**
`src/core/model.ts`
`src/core/tool-kind.ts`

The new classifier is useful, but the canonical core execution types remain:

```ts
interface RouterTool {
  type: "function";
  ...
}

interface RouterToolCall {
  type: "function";
  ...
}
```

Therefore the canonical Router model is still function-only.

`namespace`, `hosted` and `unknown` exist in an ingress classification/policy
layer, not in the internal Router tool algebra.

This is perfectly safe for today's supported subset, because unsupported classes
are rejected before reaching providers.

But it means the remediation evidence's statement:

> F2 function-only internal tool algebra — Fixed

is too strong.

### Correct independent characterization

```text
TOOL_KIND_CLASSIFICATION_EXTENSIBLE=YES
CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=NO
```

### Required remediation

Either:

1. revise the evidence to say the unsupported-kind classifier is extensible but
   canonical execution remains function-only; or

2. actually change the canonical tool model into a discriminated union.

Option 1 is sufficient if the intended product contract explicitly supports only
client-owned function tools today.

Option 2 is preferable if namespace tools are expected soon.

This finding does not reintroduce harness coupling.

---

## P4 — MEDIUM — `x_cmm` capability truth is not granular per downstream protocol

**File:** `src/core/protocol-capabilities.ts`

The descriptor publishes:

```text
protocols:
  openai_chat
  openai_responses
  anthropic_messages

tools:
  function
  namespace
  hosted
  tool_choice
  parallel_tool_calls

streaming
cancellation
developer_role
```

The latter fields are global.

That cannot express differences such as:

```text
developer role accepted on OpenAI Chat/Responses
Anthropic uses a separate system field instead
```

or future protocol-specific limitations.

It also makes `anthropic_messages: true` look broader than the actual subset
implemented by the adapter.

### Recommended correction

Nest feature truth per protocol, or clearly split:

```text
surface_available
canonical_route_capabilities
surface_specific_capabilities
```

For example:

```json
"protocols": {
  "openai_chat": {
    "available": true,
    "developer_role": true,
    "streaming": true
  },
  "anthropic_messages": {
    "available": true,
    "system_field": true,
    "tool_result_error_status": false
  }
}
```

Exact schema should remain additive.

### Independent marker

```text
CAPABILITY_PUBLICATION_TRUTHFUL=PARTIAL
```

until surface-specific gaps can be represented.

---

## P5 — MEDIUM — The Anthropic adapter silently ignores request semantics outside its implemented subset

**File:** `src/http/anthropic-messages.ts`

The adapter explicitly handles:

- model;
- stream;
- system;
- messages/content blocks;
- tools;
- tool_choice;
- max_tokens.

Other top-level request controls are not represented or explicitly rejected by
this parser.

The supplied source contains no handling for common generation controls such as:

```text
temperature
top_p
top_k
stop_sequences
```

and `max_tokens` is forwarded when it is a number but is not required/validated
as a positive integer by this surface.

This is not necessarily a security defect, but it means `ANTHROPIC_MESSAGES_COMPAT=PASS`
is broader than the static implementation supports.

### Recommended correction

Choose one:

- implement the representable fields canonically; or
- reject unsupported non-default controls explicitly.

Do not silently accept a control and then ignore its semantics.

### Correct marker today

```text
ANTHROPIC_MESSAGES_CORE_SUBSET=PASS
ANTHROPIC_MESSAGES_FULL_COMPAT=NO
```

---

## P6 — MEDIUM — Anthropic wire authentication compatibility is not demonstrated

**Files:**
`src/http/server.ts`
`src/http/anthropic-messages.ts`

Authentication is performed by the common `/v1/*` pre-handler through the
Authorization bearer header.

The supplied source contains no `x-api-key` handling.

That is fine for clients configurable to send the canonical CMM bearer as an
Authorization header.

It is not evidence that every Anthropic-protocol client can connect unchanged.

This should remain a protocol-edge compatibility question, never a
`if claude-code` branch.

### Independent marker

```text
ANTHROPIC_BEARER_AUTH=PASS
ANTHROPIC_ALTERNATE_AUTH_WIRES=UNVERIFIED
```

---

# 4. Evidence-quality finding

## E1 — LOW — Legacy alias isolation evidence overstates repository-wide centralization

The remediation evidence says:

> Every persisted legacy value now lives in `src/compat/legacy-identifiers.ts`
> ... and 0 raw literals are inlined anywhere else.

That is not literally true repository-wide.

The bundle metadata/current tree still contains legacy values in operational
scripts and templates, including examples such as:

- `CMM_QODER_TOKEN`;
- `qoder-bearer`;
- `mcp(cmm-qoder-tools/*)`;
- Qoder smoke/config scripts.

The integration test itself intentionally asserts that some of those legacy
values remain in scripts.

The correct claim is narrower:

> TypeScript production semantics centralize the legacy aliases, while
> operational compatibility scripts/templates retain the frozen external values.

That is a perfectly reasonable migration state.

### Recommended evidence marker

```text
LEGACY_TYPESCRIPT_SEMANTICS_ISOLATED=YES
LEGACY_OPERATIONAL_LITERALS_RETAINED=YES
LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO
```

---

# 5. Anthropic Messages audit

## What passes by direct inspection

The new protocol surface is genuinely client-brand-neutral.

It includes:

- `/v1/messages`;
- exact registry model resolution;
- profile-based CHAT_ONLY/CHAT_AND_TOOLS gate;
- client-owned function declarations;
- tool-use output;
- tool-result continuation;
- normalized tool-choice mapping;
- provider tool-policy enforcement;
- streaming event translation;
- abort/cancel propagation;
- Anthropic-shaped error envelopes;
- no harness identity branch.

These are meaningful additions.

## What prevents a full PASS

The two most important semantic gaps are:

1. malformed provider tool arguments are converted to `{}`;
2. `tool_result.is_error` is discarded.

Those should be fixed before calling the surface a faithful tool-capable
Anthropic Messages adapter.

---

# 6. Does the remediation achieve the user's product goal?

The product goal was:

> Qoder, DeepSeek Harness, Claude Code, Hermes, Codex and future harnesses should
> not be architectural identities. They should work when they speak a supported
> protocol/capability set.

**Yes at the core architecture level.**

The core now satisfies that principle.

A new harness name does not require:

- a core enum change;
- a new authorization role;
- a broker branch;
- model-routing logic;
- a capability exception.

That is the key success of this remediation.

The remaining defects are **protocol semantics**, exactly where they now belong.

That is a major architectural improvement.

---

# 7. Correct status markers

The independent audit would use:

```text
CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

OPENAI_CHAT_COMPAT=PASS_BY_STATIC_IMPLEMENTATION
OPENAI_RESPONSES_COMPAT=PASS_BY_STATIC_IMPLEMENTATION
ANTHROPIC_MESSAGES_CORE_SUBSET=PASS
ANTHROPIC_MESSAGES_COMPAT=PARTIAL

FUNCTION_TOOL_ROUNDTRIP=PASS_BY_IMPLEMENTATION
TOOL_KIND_CLASSIFICATION_EXTENSIBLE=YES
CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=NO

NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED

MALFORMED_TOOL_ARGUMENTS=NEEDS_FAIL_CLOSED_FIX
TOOL_RESULT_ERROR_STATUS_PRESERVED=NO

CAPABILITY_PUBLICATION_TRUTHFUL=PARTIAL

LEGACY_TYPESCRIPT_SEMANTICS_ISOLATED=YES
LEGACY_OPERATIONAL_LITERALS_RETAINED=YES
LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO

PROTOCOL_EXTENSIBILITY_REMEDIATION=PARTIAL
FINAL_CLOSURE_READY=NO
```

---

# 8. Smallest safe closure plan

Do not reopen the architecture.

The remaining closure can be one narrow hardening pass:

1. **Anthropic malformed tool arguments**
   - fail closed instead of `{}`.

2. **Tool-result error semantics**
   - add generic canonical tool-result status;
   - preserve `is_error`.

3. **Capability publication**
   - make protocol-specific truth granular enough to avoid overclaiming.

4. **Evidence correction**
   - narrow the legacy-alias isolation statement;
   - describe Anthropic as a supported subset until the remaining wire semantics
     are implemented.

5. **Optional**
   - decide whether to make `RouterTool` a true discriminated union now, or
     explicitly defer it until namespace support is designed.

No harness-specific work is needed.

No Qoder/Claude Code/DeepSeek/Codex branch should be added.

---

# 9. Verification limitation

The supplied audit bundle intentionally excludes `node_modules`.

Therefore this independent audit did **not** execute:

- Vitest;
- TypeScript compilation;
- the security-audit script.

The build report/evidence claims for those gates remain secondary evidence from
the implementation run.

This audit independently verifies:

- exact committed source architecture;
- the remediation diff;
- the absence of branded harness taxonomy in core;
- protocol/tool-policy structure;
- the semantic issues identified above.

A final executable audit should be run after the narrow closure fixes.
