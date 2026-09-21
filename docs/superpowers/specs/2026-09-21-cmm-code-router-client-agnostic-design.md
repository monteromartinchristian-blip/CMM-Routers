# CMM Code Router — Client-Agnostic Completion Design

**Date:** 2026-09-21  
**Status:** Proposed / implementation not yet started  
**Product:** CMM Routers  
**Profile:** CMM Code Router — `CHAT_AND_TOOLS`

## 1. Product statement

CMM Code Router is a **client-agnostic `CHAT_AND_TOOLS` profile**.

Qoder, Hermes, Codex and any other compatible coding/agent harness are consumers
of the profile. No individual client defines the profile, owns its identity, or
is allowed to become the security primitive that grants tool execution.

The provider/model reasons and emits structured tool intent.
CMM Code Router translates and relays that intent.
The client/harness owns and executes the tool.
The result returns through CMM Code Router to the same provider/model turn or
continuation.

Provider-native filesystem, shell, repository mutation or equivalent client
tool execution remains forbidden.

## 2. Product split

### CMMChat Router

- Profile capability: `CHAT_ONLY`.
- CMMChat remains `CHAT_ONLY` regardless of provider capability.
- Tool declarations, tool calls, tool results and tool history are rejected
  fail-closed at the Router boundary.
- Existing behavior is preserved.

### CMM Code Router

- Profile capability: `CHAT_AND_TOOLS`.
- Tool permission is the intersection of:
  1. authenticated Code Router profile;
  2. truthful provider/model `CHAT_AND_TOOLS` capability;
  3. a representable structured tool round-trip.
- It is not granted merely because a client identifies as Qoder, Hermes, Codex,
  or any other product.
- Unsupported providers/models fail closed; there is no silent downgrade that
  strips tool semantics.

## 3. Core identity model

The current architecture conflates a client identity (`QODER`) with a product
capability (`CHAT_AND_TOOLS`). Replace that relationship with two orthogonal
concepts:

```text
profile:
  CMMCHAT -> CHAT_ONLY
  CODE    -> CHAT_AND_TOOLS subject to provider/model capability

client:
  cmmchat
  qoder
  hermes
  codex
  generic-openai
  other future compatible clients
```

The `client` value is diagnostic/compatibility metadata. It MUST NOT grant tools.

The authorization decision is conceptually:

```text
effective capability =
  profile capability
  ∩ provider/model capability
  ∩ protocol representability
```

## 4. Authentication migration

Introduce a first-class Code Router bearer, conceptually:

```text
CMM_CODE_ROUTER_TOKEN
```

and the corresponding configuration/keychain plumbing.

Existing CMMChat authentication remains unchanged.

The existing `CMM_QODER_TOKEN` / `qoder-bearer` is legacy compatibility state.
Migration MUST be non-breaking:

- existing Qoder installs must continue to work;
- the legacy Qoder bearer may authenticate the Code Router profile during a
  compatibility window;
- the new Code Router bearer is the canonical path for new installs/clients;
- CMMChat bearer can never authenticate as Code Router;
- no token value is logged, embedded in tracked files, or copied into client
  configuration in plaintext when a secure supported mechanism exists.

If both Code Router and legacy Qoder bearer exist, behavior must be explicit,
tested, and deterministic. No implicit bearer fallback to CMMChat is permitted.

## 5. Client identification

A Code Router bearer authenticates the **profile**, not a vendor application.

A client may optionally supply a bounded client identifier for diagnostics and
compatibility normalization. Absence means `generic-openai`.

The identifier:

- is not an authorization primitive;
- cannot elevate capability;
- cannot select a different provider;
- cannot bypass provider/model capability;
- cannot weaken PAYG/fallback guards;
- is sanitized before logs/diagnostics.

No core code path may contain logic equivalent to:

```text
if client == QODER then tools allowed
```

## 6. Canonical HTTP contract

CMM Code Router must expose a stable OpenAI-compatible surface suitable for
generic clients where possible.

Required surfaces:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Required Code Router semantics:

- non-streaming chat;
- streaming;
- structured tool declarations;
- structured tool calls;
- `tool_choice`;
- `parallel_tool_calls` where the selected provider/model truthfully supports it;
- tool-result continuation;
- multi-step sequential tool loops;
- cancellation/abort propagation;
- reasoning/effort normalization where supported;
- vision/input modalities where supported;
- exact model selection;
- truthful capability publication.

OpenAI-compatible wire compatibility is the default integration contract.
Client-specific adapters are permitted only at the boundary for genuine protocol
quirks and MUST NOT leak into provider ownership semantics.

## 7. Provider contract

For every model exposed to CMM Code Router:

- `CHAT_AND_TOOLS` is advertised only after deterministic proof of the complete
  structured round-trip;
- provider/model discovery remains truthful;
- reasoning belongs to the provider/model;
- execution belongs to the client/harness;
- tool results are correlated to the correct session/request/turn;
- cancellation cleans pending state;
- malformed or unauthorized executable frames fail closed;
- model/provider identity cannot silently change.

Existing provider-specific bridges may be reused, but Qoder-specific naming or
authorization assumptions must not remain semantically required.

## 8. Deferred-tool / MCP bridge migration

Existing internals such as `cmm-qoder-tools` were built while Qoder was the sole
Code Router consumer.

The implementation must determine which of those names are merely legacy wire
identifiers and which encode real coupling.

Target semantics are client-neutral.

A safe migration may keep a legacy registration name temporarily if changing it
would break installed clients, but:

- internal broker APIs must become client-neutral;
- security checks must authorize the Code Router profile, not Qoder identity;
- persisted registrations must have an explicit migration/compatibility story;
- tests must prove that a non-Qoder Code Router client can complete the same tool
  round-trip.

Do not perform a cosmetic global rename that risks breaking launchd, Keychain,
AGY MCP registrations, permissions or historical evidence.

## 9. Compatibility targets

The first compatibility matrix is:

```text
Qoder
Hermes
Codex
generic OpenAI-compatible harness
```

These are **targets**, not product identities.

A client is considered supported only after:

1. deterministic contract tests pass;
2. its configuration is documented;
3. real client discovery/model selection is proven;
4. a harmless real tool round-trip is proven where tools are supported;
5. no PAYG or provider/model fallback occurs.

Additional clients should normally require documentation or a thin boundary
normalizer, not changes to provider adapters or authorization policy.

## 10. Qoder migration

Preserve the current working Qoder path while removing architectural ownership.

Required outcomes:

- existing Qoder registration remains functional;
- Qoder can use the canonical Code Router bearer;
- legacy Qoder bearer compatibility is explicit and tested;
- model reconciliation continues to preserve unmanaged/external Qoder models;
- real Qoder tool gate remains a required acceptance test;
- Task 16B multi-Mac behavior remains in the pre-stable roadmap.

Qoder remains an important first-party compatibility target, but not a special
security role.

## 11. Hermes target

Hermes must be able to point at CMM Code Router as an OpenAI-compatible provider
without requiring provider-specific CMM internals.

Acceptance must cover:

- model discovery;
- ordinary chat;
- streaming if Hermes uses it;
- tool declaration;
- tool call surfaced to Hermes;
- Hermes-owned execution;
- result continuation to the same model/provider;
- final answer.

If Hermes has client-specific schema quirks, normalize them at the client/HTTP
boundary and add dedicated tests.

## 12. Codex target

Codex is both a possible upstream provider route and a possible downstream
client/harness. Those identities must remain unambiguous in code and diagnostics.

Use a distinct client identifier such as `codex-client` or equivalent rather
than overloading provider IDs.

Acceptance must verify the actual supported custom-provider/base-URL mechanism
of the installed Codex client before claiming compatibility.

No assumption about Codex client behavior may be promoted from a mocked
OpenAI-compatible request alone.

## 13. Generic-client contract

Add a deterministic generic OpenAI-compatible acceptance harness that is not
named Qoder/Hermes/Codex.

It must prove:

```text
generic client
  -> Code Router auth
  -> exact CHAT_AND_TOOLS model
  -> structured tool declaration
  -> provider emits structured call
  -> generic client receives call
  -> client submits structured result
  -> same provider/model continues
  -> final answer
```

This is the architectural proof that CMM Code Router is client-agnostic.

## 14. Security invariants

These remain non-negotiable:

```text
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
CMMCHAT_TOOL_ESCALATION=NONE
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
LOOPBACK_ONLY=YES
TRACKED_SECRETS=NONE
```

The Code Router bearer must not weaken any existing invariant.

## 15. Capability truthfulness

Keep three concepts separate:

1. **model discovered**
2. **capabilities verified**
3. **local billing/entitlement state**

A discovered model is not automatically Code Router-compatible.

This design must remain compatible with the planned Dynamic Provider Catalog
Reconciliation work. Do not introduce another rigid model layout or hard-coded
client-specific model list.

## 16. Implementation phases

### Phase A — Architecture decoupling

- Introduce profile-vs-client identity.
- Replace Qoder-only capability grant with profile-based policy.
- Add Code Router bearer configuration.
- Preserve CMMChat and legacy Qoder behavior.
- Add migration/security tests.

### Phase B — Generic Code Router contract

- Build a client-neutral deterministic tool-roundtrip harness.
- Cover Chat Completions and Responses.
- Cover streaming, continuation, cancellation and policy normalization.
- Prove no fallback.

### Phase C — Provider bridge neutrality

- Audit Codex, Claude, Antigravity/Google, Command Code and Cavoti bridges for
  Qoder-specific assumptions.
- Remove semantic coupling while preserving proven provider behavior.
- Keep compatibility aliases where operationally necessary.

### Phase D — Client compatibility targets

- Qoder.
- Hermes.
- Codex.
- Generic OpenAI-compatible harness.

Each gets deterministic tests, setup documentation and a real-client gate.

### Phase E — Pre-stable compatibility gate

Do not declare CMM Code Router complete until the current pre-stable provider
compatibility roadmap is satisfied, including the open Google/GPT-OSS work,
Codex revalidation when quota permits, Command Code when enabled, Task 16B and
the final real-client gate.

## 17. Acceptance markers

The final closure evidence should include at minimum:

```text
CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS
CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES
QODER_CODE_ROUTER=PASS
HERMES_CODE_ROUTER=PASS
CODEX_CLIENT_CODE_ROUTER=PASS
GENERIC_OPENAI_CODE_ROUTER=PASS

CMMCHAT_CHAT_ONLY=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE

NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES

MODEL_CAPABILITY_TRUTHFULNESS=PASS
CODE_ROUTER_REAL_CLIENT_GATE=PASS
```

Any client/provider/model combination that cannot prove the complete round-trip
must be reported truthfully as unsupported or pending. It must not be silently
downgraded or marked passing.

## 18. Non-goals for this workstream

- Do not finish or merge CMM Routers Console.
- Do not implement Dynamic Provider Catalog Reconciliation in this task except
  to avoid blocking its future architecture.
- Do not perform the `$HOME/CMM-Routers` -> `$HOME/CMM Routers` migration here.
- Do not expand to new providers solely for this task.
- Do not publish, tag, release or push without separate approval.
- Do not rewrite historical audit evidence.
- Do not weaken tests/timeouts/security gates merely to obtain green output.

## 19. Implementation discipline

- Use an isolated worktree.
- Preserve the current Antigravity/Google workstream.
- TDD for behavioral changes.
- Small, reviewable commits grouped by phase.
- Run focused tests after each phase.
- Require full build/typecheck/security/full-suite verification before closure.
- Real client/provider calls that consume quota require explicit gating and
  should use the smallest harmless canary capable of proving the contract.
- Never print or persist bearer/token values in reports.

