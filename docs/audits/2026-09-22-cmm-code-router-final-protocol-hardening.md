# CMM Code Router — Final Protocol Hardening Evidence

**Date:** 2026-09-22
**Directing audit:** `docs/audits/2026-09-22-cmm-code-router-independent-protocol-extensibility-audit-7c5e68b.md`
**Branch:** `feature/cmm-code-router-client-agnostic`
**Nature:** Closure evidence for findings P1–P6 and E1. Historical audits and the
previous remediation evidence are **not** rewritten; corrections are made here.

## 1. Revisions

- **START_HEAD:** `58652381f3aecf97fbc387f253bb724716a19b1a`
- **Code + verification HEAD:** `ad75c2e756616800533d1f8ddff0cb49af5196fb`
- The evidence-document commit follows it; the true final HEAD is reported in the
  run report so this document never has to state its own hash.

## 2. Findings closed

| Finding | Change |
|---|---|
| **P1** malformed tool arguments fabricated `{}` | arguments validated on all three surfaces; fail closed, no repair, no substitution |
| **P2** `tool_result.is_error` discarded | canonical `toolResultStatus`, mapped per wire |
| **P3** canonical tool algebra still function-only | `RouterTool` is a discriminated union; executable path narrowed |
| **P4** `x_cmm` not protocol-scoped | per-protocol surface truth + separate canonical algebra truth |
| **P5** Anthropic controls accepted and ignored | refused by name; `max_tokens` validated |
| **P6** Anthropic auth wire compatibility implied | alternate wire implemented and declared truthfully |
| **E1** legacy isolation overstated | corrected below |

### P1 — malformed provider tool arguments fail closed

A provider payload that is not valid JSON is never turned into executable
arguments. `parseToolArguments` / `validateToolCalls` are applied before any call
is surfaced, on Chat Completions, Responses and Anthropic Messages. There is no
heuristic repair.

The Anthropic streaming path additionally **buffers** tool arguments instead of
streaming them, so a tool block is only opened once its payload is known to be
usable. A malformed payload produces `event: error` and never a `tool_use`.

### P2 — canonical tool-result outcome

`RouterMessage.toolResultStatus` is a generic `success | error`. Mapping is
truthful per wire:

- Anthropic ingress preserves the explicit outcome (absent/false = success);
- the Anthropic upstream wire round-trips it as `is_error`;
- bridges that flatten a result into router-authored text mark the outcome in that
  text (success text is byte-identical, so this is additive for the error case);
- OpenAI-wire upstreams have no error bit: content is preserved verbatim and the
  status stays canonical/internal. **No wire field was invented and no support is
  faked.**

### P3 — the canonical algebra is now genuinely extensible

`RouterTool` is a discriminated union able to represent `function`, `namespace`,
`hosted` and opaque/unknown. Ingress constructs declarations through it and
narrows with `isFunctionTool`, so the union is load-bearing rather than declared.
`RouterRequest.tools` is narrowed to `RouterFunctionTool[]`, so a provider adapter
can never receive a class it does not support.

Representable ≠ executable ≠ allowed. Policy is unchanged and applied before
provider invocation. **Namespace flattening is deliberately not implemented**: it
must first be generic, reversible, collision-safe and brand-independent.

### P4 — protocol-scoped capability truth

`x_cmm.code_router` is preserved. `x_cmm.protocols.<surface>` now carries that
surface's own `available`, `streaming`, `cancellation`, role handling,
tool-class truth, provider-specific tool policy, accepted auth wires and
per-control truth; `x_cmm.canonical_tools` carries protocol-independent algebra
truth. Real differences are visible rather than flattened (OpenAI surfaces accept
the `developer` role; the Anthropic-compatible surface uses a dedicated `system`
field and reports `developer_role: false`).

### P5 / P6 — Anthropic surface truthfulness

- `temperature`, `top_p`, `top_k`, `stop_sequences` and other unrepresentable
  semantic controls are **refused by name**; an unknown request key is refused
  generically; `max_tokens` must be a positive integer.
- An API-key-style header is accepted as a **wire alternative** for the same
  configured secrets. It maps to the same profile resolution, creates no third
  credential role (a CMMChat API key is still CHAT_ONLY and gets no tools), and a
  request carrying two competing credentials fails closed. Bearer remains
  supported; no secret is logged.

## 3. Evidence corrections (E1 and the tool-algebra claim)

**E1 — legacy alias isolation.** The previous evidence said every persisted legacy
value "lives in `src/compat/legacy-identifiers.ts` … and 0 raw literals are
inlined anywhere else". That was true of **TypeScript production semantics**, not
of the repository as a whole. The accurate statement is:

```text
LEGACY_TYPESCRIPT_SEMANTICS_ISOLATED=YES
LEGACY_OPERATIONAL_LITERALS_RETAINED=YES
LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO
```

Operational scripts and templates (`scripts/macos/*`, `docs/*`, the `agy`
permission provisioner, the smoke script) intentionally keep the frozen external
literals, because those are the durable external values. Persisted values are
unchanged.

**Tool algebra claim.** The previous evidence marked "F2 function-only internal
tool algebra — Fixed". The independent audit correctly noted that the classifier
alone did not make the canonical execution algebra extensible. After this closure
the claim is true as written in §P3 above; before it, only the classifier was
extensible.

**Anthropic status.** The previous `ANTHROPIC_MESSAGES_COMPAT=PASS` is superseded.
The surface implements a tested subset and refuses what it cannot represent, so
the truthful verdict is:

```text
ANTHROPIC_MESSAGES_COMPAT=PARTIAL_WITH_EXPLICIT_TRUTH
```

## 4. Verification

| Gate | Result |
|---|---|
| New hardening tests (malformed args, tool-result status, canonical algebra, protocol-scoped capabilities, Anthropic controls/auth) | PASS |
| All Anthropic Messages tests | PASS |
| OpenAI Chat/Responses generic tests | PASS |
| Profile/auth tests | PASS |
| Broker / adversarial / cancellation / concurrency | PASS |
| Compiled-process E2E | PASS |
| Capability truthfulness | PASS |
| Focused battery (69 files / 361 tests) | PASS |
| `npm run typecheck` | `TYPECHECK=PASS` |
| `npm run build` | `BUILD=PASS` |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| `git diff --check` | clean |
| Full suite | 8 failed files / 19 failed / **941 passed** / 25 skipped (985) |

### Full-suite classification

The 8 failing files are the pre-existing environmental family and match the
starting-HEAD set exactly: `launchd-deterministic`, `launchd-fail-closed`
(provider binaries unresolvable on this machine), `preflight-config`,
`preflight-failclosed`, `preflight-matrix` (5 s timeouts of an unmodified script),
`claude-adapter` (5 s timeout), and the three `publication/*` files (git/remote
infrastructure). No new failing file was introduced by this closure, no timeout
was raised, no test was skipped, and no assertion was weakened.

## 5. Required markers

```text
START_HEAD=58652381f3aecf97fbc387f253bb724716a19b1a
END_HEAD=see run report

CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

OPENAI_CHAT_COMPAT=PASS
OPENAI_RESPONSES_COMPAT=PASS
ANTHROPIC_MESSAGES_COMPAT=PARTIAL_WITH_EXPLICIT_TRUTH

MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
MALFORMED_TOOL_ARGUMENTS_NOT_EXECUTABLE=PASS
NO_ARGUMENT_FABRICATION=PASS
TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS
TOOL_RESULT_SUCCESS_STATUS_PRESERVED=PASS
TOOL_RESULT_STATUS_HARNESS_AGNOSTIC=PASS

CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
FUNCTION_TOOL_KIND=SUPPORTED
NAMESPACE_TOOL_KIND=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_KIND=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED
UNSUPPORTED_TOOL_NEVER_REACHES_PROVIDER=PASS

CAPABILITY_PUBLICATION_PROTOCOL_SCOPED=PASS
CAPABILITY_PUBLICATION_TRUTHFUL=PASS
CAPABILITY_PUBLICATION_NOT_AUTHORIZATION=PASS
UNKNOWN_CAPABILITY_NOT_PROMOTED=PASS
ANTHROPIC_REQUEST_CONTROLS_TRUTHFUL=PASS
ANTHROPIC_AUTH_WIRE_TRUTHFUL=PASS
ANTHROPIC_AMBIGUOUS_AUTH_FAILS_CLOSED=PASS

LEGACY_TYPESCRIPT_SEMANTICS_ISOLATED=YES
LEGACY_OPERATIONAL_LITERALS_RETAINED=YES
LEGACY_PERSISTED_IDENTIFIERS_CHANGED=NO
LEGACY_WIRE_ALIASES=EXPLICIT_COMPAT_ONLY

CMMCHAT_CHAT_ONLY=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE

NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
TRACKED_SECRETS=NONE
LOOPBACK_ONLY=YES

TYPECHECK=PASS
BUILD=PASS
SECURITY_AUDIT=PASS
FULL_SUITE=FAIL_WITH_CLASSIFIED_EVIDENCE

LIVE_PROVIDER_INFERENCE_RUN=NO
PUSH_PERFORMED=NO
MERGE_PERFORMED=NO
PUBLICATION_PERFORMED=NO
TAG_CREATED=NO
PR_CREATED=NO
WORKTREE_CLEAN=YES

NEXT=FINAL_INDEPENDENT_AUDIT
```

## 6. Remaining gaps (truthful)

- `namespace` declarations are representable but `EXPLICIT_UNSUPPORTED`; a safe
  generic flattening design is still required before they can execute.
- `hosted`/provider-side tools stay `EXPLICIT_UNSUPPORTED` while
  `CLIENT_OWNS_TOOLS=YES`.
- The Anthropic-compatible surface is a **declared subset**: generation controls
  are refused rather than implemented, and real-client verification is still a
  separate gate.
- The full suite's 8 environmental failures are unchanged from the starting HEAD.
