# CMM Code Router — Direct Harness-Agnostic Architecture Audit

**Date:** 2026-09-22
**Audited revision:** `ebfb80d1c8826a5fd46d093a2ab40c08e74443f8`
**Baseline for overnight diff:** `373262d989a2ab999e82a885a5281ffe0e5b5249`
**Method:** direct static inspection of the committed `git archive` bundle plus the included exact range diff and metadata. No claims in the overnight evidence were accepted merely because they were written in an audit document.

## Executive verdict

The current Code Router is **semantically client-neutral in its authorization, routing and broker**, but it is **not yet fully harness-agnostic as a product surface**.

The most important distinction is:

- the **core security model is in good shape**;
- the **protocol surface is still narrower than the product goal**.

Today, an arbitrary harness can work without being known by name **if it can speak one of the currently implemented OpenAI-compatible surfaces and express its tools as ordinary client-owned function tools**.

That is materially different from:

> any harness can be connected without changing CMM Code Router.

To reach the latter, the remaining work should be protocol-centric, not harness-centric.

### Verdict markers

```text
CORE_HARNESS_AGNOSTIC=PARTIAL
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_SELECTION_HARNESS_AGNOSTIC=YES
MODEL_DISCOVERY_PROTOCOL_COVERAGE=PARTIAL
TOOL_PROTOCOL_HARNESS_AGNOSTIC=PARTIAL

HARNESS_SPECIFIC_AUTHORIZATION=NONE_FOUND
HARNESS_SPECIFIC_MODEL_ROUTING=NONE_FOUND
HARNESS_SPECIFIC_BROKER_LOGIC=NONE_FOUND

HARNESS_NAMES_IN_CORE=YES
LEGACY_WIRE_ALIASES=EXPLICIT_COMPAT_BUT_NOT_YET_ISOLATED
ANY_COMPATIBLE_HARNESS_WITH_FUNCTION_TOOLS=YES
LITERALLY_ANY_HARNESS=NO
```

---

## 1. Provenance and integrity

The supplied bundle is the committed state of:

- branch `feature/cmm-code-router-client-agnostic`;
- HEAD `ebfb80d1c8826a5fd46d093a2ab40c08e74443f8`;
- clean worktree;
- baseline `373262d...` is an ancestor;
- archive contains tracked Git state only.

The tarball SHA-256 independently recalculates to:

`320a6fba0450dedbb99d864486d74b56f8154413c4034fee5cb5ab5a706510d4`

which matches the build report.

The overnight range is a linear chain of 14 commits with no merge commits.

---

## 2. What is already correctly harness-agnostic

### 2.1 Authorization is profile-based, not harness-based — PASS

`src/core/router-profile.ts:1-30`

The effective tool decision is based only on:

```text
Router profile × truthful provider/model capability
```

`effectiveProfileToolCapability()` has no client/harness input.

This is the correct security boundary.

`src/http/server.ts:87-112` authenticates a request into a profile first; application metadata is attached separately.

`src/http/openai-chat.ts:437-445` and `src/http/openai-responses.ts:262-273` use `identity.profile`, not client identity, for tool authorization.

No source path was found where `qoder`, `hermes`, `codex-client` or another harness name elevates a request to `CHAT_AND_TOOLS`.

### 2.2 Broker is genuinely client-neutral — PASS

`src/core/deferred-tool-broker.ts:5-31`

`BrokerKey.consumer` has been removed. The broker now correlates:

- provider;
- session;
- optional turn;
- public tool-call id;
- provider-private context.

There is no client/harness identity in broker authorization or correlation.

This is a real architectural improvement, not just a rename.

### 2.3 Exact model selection is harness-neutral — PASS

`src/registry/provider-registry.ts:86-159`

The resolver requires the exact `provider/model` ID, verifies the provider is registered, refreshes discovery when stale, and rejects a missing model.

There is no fallback to another provider/model and no client-name branch.

### 2.4 Capability publication does not authorize — PASS

`src/http/server.ts:143-163`

`GET /v1/models` publishes the already-known model capability under:

```json
"x_cmm": { "code_router": "CHAT_AND_TOOLS" }
```

The value comes from `model.capability`; it is not derived from the caller/harness.

### 2.5 Unsupported tool shapes fail closed — PASS

`src/http/openai-responses.ts:115-185`

The Responses parser accepts representable function tools and explicitly returns `unsupported_capability` for other tool types instead of silently deleting them.

That behavior should be preserved while adding more protocol capabilities.

---

# 3. Harness leakage findings

## F1 — MEDIUM — Branded harness identities still live in `src/core`

**Classification:** CORE LEAKAGE, diagnostics-only

`src/core/client-identity.ts:15-18` defines:

```text
qoder
hermes
codex-client
generic-openai
```

and `src/core/client-identity.ts:35-63` uses a closed allow-list of known clients.

This does **not** currently affect authorization, provider selection or broker behavior, so it is not a security bug.

It is nevertheless incompatible with the strict product requirement that the core should not need to know which harness exists.

A future DeepSeek Harness, Claude Code-compatible wrapper, Cline, Roo or unknown client is collapsed into `other` until the core source is changed.

### Recommended correction

Replace the branded enum with one of:

1. no client label at all in core; or
2. an optional bounded opaque diagnostic label.

Example conceptual model:

```text
profile: cmmchat | code
clientLabel?: sanitized bounded string
```

No list of known harnesses.

If branded classification is wanted for dashboards, do it outside the authorization/core layer.

---

## F2 — HIGH — The canonical internal tool algebra is function-only

**Classification:** PROTOCOL CAPABILITY LIMIT

`src/core/model.ts:53-69`

The core type itself says:

```ts
RouterTool.type = "function"
RouterToolCall.type = "function"
```

Therefore non-function tool concepts cannot reach provider adapters without first being converted to functions or rejected.

This is the real architectural reason the current Router cannot faithfully consume every harness protocol.

The Codex-client finding is merely one concrete symptom.

### Consequences

Current core cannot natively represent:

- namespace/grouped tool declarations;
- hosted/provider-side tools;
- future tool kinds that are not ordinary JSON-schema functions.

### Important nuance

This does **not** mean the correct fix is “add Codex namespace support”.

The correct design question is:

> Which tool capability classes does CMM Code Router support generically, and who owns execution for each class?

For example:

```text
client_function        -> client/harness executes
namespace_group        -> protocol-edge construct, possibly reversible flattening
provider_hosted_tool   -> distinct policy class; currently forbidden or unsupported
```

Do not weaken `CLIENT_OWNS_TOOLS=YES` accidentally while solving hosted-tool compatibility.

---

## F3 — HIGH — Downstream protocol coverage is limited to two OpenAI-family surfaces

**Classification:** PROTOCOL BOUNDARY LIMIT

Current registered public coding surfaces are:

- `/v1/chat/completions`
- `/v1/responses`

`src/http/server.ts:168-173`

This is enough for clients that can be configured to one of those protocols.

It is **not** a universal harness boundary.

A harness that speaks Anthropic Messages, another agent protocol, or a future protocol cannot connect merely because the core is client-neutral.

### Product implication

The correct promise is currently:

> Any harness compatible with CMM Code Router's supported protocols can connect.

It is not yet:

> Any harness can connect.

### Recommended architecture

Create explicit downstream protocol adapters:

```text
compat/http/openai-chat
compat/http/openai-responses
compat/http/anthropic-messages
compat/http/<future protocol>
        ↓
canonical RouterRequest / RouterEvent core
```

Provider adapters remain unchanged.

This is the architecture that lets Claude Code, DeepSeek Harness or a future tool be added by protocol rather than brand.

---

## F4 — HIGH — Capability discovery is too coarse for a universal harness router

**Classification:** PROTOCOL NEGOTIATION GAP

`src/core/model.ts:26-36` exposes only:

```text
CHAT_ONLY
CHAT_AND_TOOLS
```

and `/v1/models` publishes only that binary verdict.

That is enough to decide whether ordinary function tools can be attempted.

It is not enough for a harness to determine whether the selected route can represent:

- Chat Completions;
- Responses;
- Anthropic Messages;
- function tools;
- namespace grouping;
- hosted tools;
- named `tool_choice`;
- required/none/auto policy;
- parallel tools;
- vision;
- reasoning effort;
- cancellation;
- developer-role semantics.

This is now a core requirement for the harness-agnostic product, not merely a Qoder synchronization nicety.

### Recommended correction

Implement a richer protocol/capability descriptor without implementing the full future Dynamic Provider Catalog project.

Conceptually:

```json
{
  "x_cmm": {
    "profile": "CHAT_AND_TOOLS",
    "protocols": {
      "openai_chat": true,
      "openai_responses": true,
      "anthropic_messages": false
    },
    "tools": {
      "function": true,
      "namespace": false,
      "hosted": false,
      "parallel": true
    }
  }
}
```

Exact schema should be designed before implementation.

This should describe truth, never grant authorization.

---

## F5 — MEDIUM — Model discovery wire is itself a compatibility surface

**Classification:** PROTOCOL BOUNDARY

The current `/v1/models` response is the normal OpenAI list shape:

```text
object=list
data=[...]
```

`src/http/server.ts:150-163`

The real installed Codex client evidence says that its custom-provider discovery expected a `models` member instead and then fell back when it could not decode the response.

That should not be solved with:

```text
if client == codex
```

It should be treated as a model-discovery protocol compatibility question.

Potential generic solutions include an additive compatibility representation or a dedicated protocol-edge discovery adapter.

Do not put a downstream product name into model-routing logic.

---

## F6 — MEDIUM — `developer` normalization exists only on Responses

**Classification:** PROTOCOL BOUNDARY INCONSISTENCY

`src/http/openai-responses.ts:58-64` maps `developer` to internal `system`.

`src/http/openai-chat.ts:60-72` only accepts:

- system;
- user;
- assistant;
- tool.

Therefore a client that sends a developer role on the Chat surface is rejected.

This is not a harness-specific bug; it is an ingress protocol coverage decision.

The protocol spec should state whether `developer` is supported on each surface and tests should enforce the chosen behavior.

---

## F7 — LOW/MEDIUM — Legacy Qoder wire identifiers are still scattered through production code

**Classification:** LEGACY COMPATIBILITY ALIAS

Examples:

- `src/providers/antigravity/mcp-registration.ts:29`
- `src/providers/antigravity/adapter.ts:765`
- `src/bridge/mcp-bridge-launcher.ts:76`
- `src/bridge/mcp-bridge-process.ts:178`
- `src/providers/claude/deferred-tools.ts:36,52-53`
- `src/providers/claude/adapter.ts:849,855,915`
- `src/core/consumer-capability.ts:30,43`
- `src/http/identity.ts:26,36,56-57,130`

The current values are operational compatibility identifiers and should **not** be renamed blindly.

They no longer appear to grant tools or select providers based on Qoder identity.

That means they are acceptable temporarily.

### Recommended correction

Centralize them behind an explicit legacy compatibility module/constants layer so production logic refers to semantic names:

```text
legacyCodeRouterMcpServerName
legacyCodeRouterBearerEnv
legacyClaudeBridgeServerName
```

with the persisted value still equal to the historical Qoder string.

Then remove the deprecated layer only in a separately planned migration.

---

## F8 — LOW — `codexUnsupportedToolPolicy` is misleadingly named in the HTTP boundary

**Classification:** NAMING / PROVIDER-HARNESS AMBIGUITY

`src/http/openai-chat.ts:258-267`

The function is actually a generic wrapper around `enforceProviderToolPolicy()` and is used for every provider.

Its name makes an upstream provider rule look like downstream Codex-client logic.

Rename to something such as:

```text
enforceSelectedProviderToolPolicy
```

or call `enforceProviderToolPolicy` directly.

This is small but worthwhile now that upstream provider and downstream harness concepts must remain sharply separated.

---

# 4. Evidence-quality findings

These are not runtime defects, but they should be corrected before treating the overnight evidence as formal closure.

## E1 — File-count arithmetic is wrong

`docs/audits/2026-09-22-cmm-code-router-overnight-completion-evidence.md`

The table reports:

```text
Phase 3 = 24
Phase 4 = 9
Phase 5 = 9
Phase 6+7 = 9
Total = 46
```

but:

```text
24 + 9 + 9 + 9 = 51
```

The direct range inventory also contains **51 changed files**.

So the table's total is an arithmetic error.

## E2 — Codex captured-tool arithmetic is internally inconsistent

`docs/audits/2026-09-22-cmm-code-router-phase7-real-client-gates-evidence.md:83-85`

It says:

```text
31 entries
19 function
18 namespace
1 web_search
```

but those categories sum to **38**, not 31.

The archive does not contain the raw redacted capture necessary to determine which count is correct.

Therefore the architectural conclusion — non-function tool types were observed — is supported by the code changes and evidence narrative, but the exact captured counts should not be treated as audited truth until reconciled.

Recommendation: retain a secret-free structural capture in future evidence, e.g.:

```json
{"total":31,"by_type":{"function":12,"namespace":18,"web_search":1}}
```

without prompts, arguments or credentials.

---

# 5. Direct answer to the product question

## Can CMM Code Router already support Qoder, Hermes, Codex, Claude Code, DeepSeek Harness and future harnesses without knowing their names?

**Not universally yet.**

It already has the right **security/core direction**:

```text
harness name ─X─> authorization
harness name ─X─> model routing
harness name ─X─> broker ownership
```

But a harness can currently connect only if its wire behavior fits the implemented protocol envelope:

```text
OpenAI Chat Completions or OpenAI Responses
+
client-owned function tools
+
currently representable policy/options
```

That is why the next work should not be “support Qoder/Hermes/Codex”.

It should be:

> Make CMM Code Router a protocol-extensible agent gateway.

---

# 6. Correct target architecture

```text
Qoder ────────────┐
Hermes ───────────┤
Codex ────────────┤
Claude Code ──────┤
DeepSeek Harness ─┤
Cline / Roo ──────┤
future client ────┘
          │
          ▼
┌───────────────────────────────────┐
│ DOWNSTREAM PROTOCOL COMPATIBILITY │
│                                   │
│ OpenAI Chat Completions           │
│ OpenAI Responses                  │
│ Anthropic Messages                │
│ future protocol adapters          │
└───────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────┐
│ CMM CODE ROUTER CORE              │
│                                   │
│ profile authorization             │
│ exact model resolution            │
│ canonical messages                │
│ canonical tool capabilities       │
│ correlation / cancellation        │
│ capability truth                  │
└───────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────┐
│ UPSTREAM PROVIDER ADAPTERS        │
│ ChatGPT / Claude / Google / ...   │
└───────────────────────────────────┘
```

Harness names belong outside the core.

---

# 7. Recommended remediation order

## Step 1 — Remove branded client identity from core

Smallest and safest.

- replace the known-harness enum with optional bounded diagnostic metadata;
- no product names in `src/core/client-identity.ts`;
- canonical bearer defaults to no/anonymous generic label;
- legacy bearer may carry a legacy diagnostic tag outside the core compatibility boundary;
- prove metadata cannot affect auth/routing/broker.

This should not change runtime tool behavior.

## Step 2 — Freeze a protocol-capability model

Before adding more client adapters, define what the Router can represent.

Separate:

```text
transport/protocol
message capabilities
tool declaration capabilities
tool execution owner
tool policy capabilities
model modalities
```

Do not use client brands in the schema.

## Step 3 — Refactor the internal tool model

Do not immediately implement every possible tool kind.

First make the internal model capable of expressing or explicitly classifying them.

At minimum distinguish:

```text
client-owned function
group/namespace declaration
hosted/provider-side tool
unsupported/opaque future declaration
```

Then decide policy for each.

### Security constraint

Do not accidentally turn hosted tools on merely to make one harness work.

If provider-native execution remains forbidden, hosted tools should be published as unsupported until a deliberate security decision changes that invariant.

## Step 4 — Make ingress protocol adapters explicit

Keep current OpenAI Chat and Responses behavior, but route them through a clear compatibility boundary.

Then add **Anthropic Messages-compatible ingress** as the next protocol family if Claude Code-style harnesses are a target.

No provider adapter should care which downstream harness caused the request.

## Step 5 — Rich `x_cmm` capability truth

Publish protocol/tool feature truth so a generic client can know what is representable.

This can be done without implementing the full Dynamic Provider Catalog project.

## Step 6 — Protocol-centric acceptance suite

Core completion gates should become:

```text
PROFILE_AUTHORIZATION=PASS
EXACT_MODEL_SELECTION=PASS

OPENAI_CHAT_COMPAT=PASS
OPENAI_RESPONSES_COMPAT=PASS
ANTHROPIC_MESSAGES_COMPAT=<PASS|PENDING>

FUNCTION_TOOL_ROUNDTRIP=PASS
STREAMING_TOOL_ROUNDTRIP=PASS
MULTISTEP_TOOL_LOOP=PASS
CANCELLATION=PASS
PARALLEL_TOOL_POLICY=PASS

NAMESPACE_TOOL_CAPABILITY=<SUPPORTED|EXPLICITLY_UNSUPPORTED>
HOSTED_TOOL_CAPABILITY=<SUPPORTED|EXPLICITLY_UNSUPPORTED>

CLIENT_OWNS_TOOLS=YES
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
```

Then keep product-specific rows only as examples:

```text
Qoder            compatibility observation
Hermes           compatibility observation
Codex            compatibility observation
Claude Code      compatibility observation
DeepSeek Harness compatibility observation
```

None of them defines core completion.

---

# 8. What does NOT need to block the harness-agnostic core

These should stay outside the definition of core completion:

- Qoder UI registration;
- Hermes UI/config workflow;
- Codex brand-specific setup;
- Task 16B multi-Mac Qoder synchronization;
- Qoder model reconciliation;
- specific client branding in docs;
- future Dynamic Provider Catalog reconciliation;
- local path rename.

What **does** matter is the generic protocol capability exposed underneath them.

---

# 9. Final assessment

The overnight work did not produce a disguised “Qoder Router”.

The important security pieces are genuinely generalized:

- profile-based authorization;
- no harness-specific broker key;
- exact model routing;
- generic function-tool roundtrip;
- fail-closed unsupported capabilities.

The remaining problem is more fundamental and cleaner:

> **CMM Code Router is currently harness-neutral but protocol-limited.**

That is a good place to be.

The next implementation should therefore focus on **protocol extensibility and capability truth**, while removing the remaining branded diagnostics from core.

### Final markers

```text
AUTH_HARNESS_AGNOSTIC=PASS
BROKER_HARNESS_AGNOSTIC=PASS
MODEL_ROUTING_HARNESS_AGNOSTIC=PASS
CLIENT_METADATA_HARNESS_AGNOSTIC=FAIL
LEGACY_ALIASES_ISOLATED=PARTIAL
OPENAI_CHAT_COMPAT=PASS_BY_IMPLEMENTATION
OPENAI_RESPONSES_COMPAT=PASS_BY_IMPLEMENTATION
FUNCTION_TOOL_CORE=PASS
NAMESPACE_TOOL_CORE=UNSUPPORTED
HOSTED_TOOL_CORE=UNSUPPORTED
ANTHROPIC_INGRESS=ABSENT
PROTOCOL_CAPABILITY_NEGOTIATION=INSUFFICIENT

CORE_HARNESS_AGNOSTIC=PARTIAL
NEXT=PROTOCOL_EXTENSIBILITY_REMEDIATION
```

## Verification limitation

This direct audit validates the **committed architecture and exact diff** from the supplied bundle.

The bundle intentionally excludes `node_modules`, so this environment did not independently rerun the TypeScript build/Vitest suite. Runtime PASS counts remain claims from the included evidence until separately reproduced from an executable dependency environment.

This limitation does not affect the static harness-leakage findings above.
