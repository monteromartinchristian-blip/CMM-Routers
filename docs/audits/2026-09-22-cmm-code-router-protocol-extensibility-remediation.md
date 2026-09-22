# CMM Code Router — Protocol Extensibility Remediation Evidence

**Date:** 2026-09-22
**Directing audit:** `docs/audits/2026-09-22-cmm-code-router-direct-harness-agnostic-audit.md`
**Branch:** `feature/cmm-code-router-client-agnostic`
**Nature:** Implementation evidence. Historical audits are not rewritten; two
corrective notes were appended instead.

## 1. Revisions

- **START_HEAD:** `27650ab5d3bf319c99cb51810160ec024f9b1395`
- **Code + verification HEAD:** `805aff78e0a4c9b1c9d4b1f5a3a6c3f7a5c8c1d2` *(see the run
  report for the resolved value)*
- The evidence documents are added in a final docs-only commit.

## 2. What the audit found, and what was done

| Finding | Severity | Resolution |
|---|---|---|
| F1 branded harness identities in `src/core` | MEDIUM | **Fixed** — opaque label (Subphase A) |
| F2 function-only internal tool algebra | HIGH | **Fixed** — capability-class algebra + policy (Subphase C) |
| F3 protocol coverage limited to two OpenAI surfaces | HIGH | **Addressed** — explicit adapters + Anthropic Messages ingress (Subphase D) |
| F4 coarse capability discovery | HIGH | **Addressed** — protocol-centric additive `x_cmm` (Subphase B) |
| F5 discovery wire is itself a compatibility surface | MEDIUM | **Addressed** — additive `models` alias, no brand branch |
| F6 `developer` role only on Responses | MEDIUM | **Fixed** — normalized on the Chat surface too |
| F7 legacy Qoder names scattered | LOW/MED | **Fixed** — one compat module, 0 inlined sites |
| F8 `codexUnsupportedToolPolicy` misnamed | LOW | **Fixed** — `enforceSelectedProviderToolPolicy` |
| E1 overnight file-count total | evidence | **Corrected by note** (51, not 46) |
| E2 Codex tool arithmetic | evidence | **Corrected by note** (31 = 12 + 18 + 1) |

## 3. Subphase A — core carries no harness taxonomy

`profile` is the security identity; `clientLabel` is an optional, bounded,
sanitized, opaque diagnostic string. There is no allow-list, enum or "other"
bucket: an unrecognized value is preserved opaquely, so a harness that does not
exist yet needs no core change. Absence is normal, and a value that sanitizes
away is treated as absence rather than a synthetic category.

The historical "consumer" vocabulary moved out of `src/core` into
`src/compat/deprecated-consumer.ts`; `src/core/consumer-capability.ts` is gone.

Proven: `ABSENT_CLIENT_LABEL`, `ARBITRARY_CLIENT_LABEL`, `CLIENT_LABEL_SANITIZED`,
`CLIENT_LABEL_BOUNDED`, `CLIENT_LABEL_NOT_AUTHORIZATION`,
`CLIENT_LABEL_NOT_ROUTING`, and a scan asserting no harness name appears anywhere
under `src/core`.

## 4. Subphase B — protocol-centric capability truth

`x_cmm` is extended additively; `x_cmm.code_router` is preserved unchanged:

```json
"x_cmm": {
  "code_router": "CHAT_AND_TOOLS",
  "protocols": { "openai_chat": true, "openai_responses": true, "anthropic_messages": true },
  "tools": { "function": true, "namespace": false, "hosted": false,
             "tool_choice": "full", "parallel_tool_calls": true },
  "streaming": true, "cancellation": true, "developer_role": true
}
```

Truth rules: the descriptor is built from the model verdict plus the upstream
provider's representability; a model with no verified verdict publishes **no**
tool truth at all; `tool_choice` is `full` or `auto_only` per provider rather
than a blanket claim. Publication grants nothing — the tool gate remains
`profile ∩ capability`.

`GET /v1/models` also carries an additive `models` alias with the same entries as
`data`, so a discovery client expecting that member can decode the response
without the Router branching on client identity.

## 5. Subphase C — extensible tool algebra

```text
function   -> SUPPORTED            (client-owned; representable without loss)
namespace  -> EXPLICIT_UNSUPPORTED (known class, refused by name)
hosted     -> EXPLICIT_UNSUPPORTED (provider-side execution stays forbidden)
unknown    -> FAIL_CLOSED          (never guessed)
```

Both OpenAI surfaces and the Anthropic ingress use the same classifier and the
same policy table, so the same wire class produces the same decision everywhere.
A partially representable list is refused as a whole — the representable function
is never forwarded on its own. Messages name both the class and the wire type.

Representation is not permission: `SUPPORTED` means the Router can carry the
declaration, never that a provider may execute it. Provider-native execution
remains independently forbidden.

## 6. Subphase D — explicit downstream protocol adapters

`POST /v1/chat/completions`, `POST /v1/responses` and the new
`POST /v1/messages` are all explicit adapters into canonical Router semantics.

The Anthropic Messages-compatible ingress supports model selection, system
prompts, user/assistant messages, `text`/`tool_use` blocks, `tool_result`
continuation, tool declarations, `tool_choice` (`auto`/`none`/`any`/`tool` with
`disable_parallel_tool_use`), non-streaming and **streaming** (the canonical
event lifecycle with `input_json_delta`), exact model selection, CHAT_ONLY
rejection, and Anthropic-shaped errors including the 401 envelope.
Unrepresentable content blocks are refused by name.

No provider adapter knows which downstream protocol produced a request.

## 7. Naming and legacy isolation

`enforceSelectedProviderToolPolicy` replaces `codexUnsupportedToolPolicy`.

Every persisted legacy value now lives in `src/compat/legacy-identifiers.ts`
behind a semantic name. Values are byte-identical to before, so persisted `agy`
registrations, Keychain items, rendered LaunchAgents and live provider
configuration keep working. The audit asserts both that the values are frozen
there and that **0** raw literals are inlined anywhere else.

`mcp(cmm-qoder-tools/*)` is documented in that module as both a legacy name and an
active security scope that must never be widened.

## 8. Verification

| Gate | Result |
|---|---|
| New remediation tests (core label, tool kind, tool-kind surfaces, protocol publication, Anthropic ingress, label diagnostics) | PASS |
| Phase 1 auth/profile tests | PASS |
| Generic protocol tests (chat, responses, streaming, multi-step, cancellation, broker, no-fallback) | PASS |
| Broker / adversarial / cancellation / concurrency | PASS |
| Compiled-process E2E | PASS |
| Capability truthfulness | PASS |
| Brand-specific compatibility tests (non-blocking examples) | PASS |
| Focused battery (29 files / 169 tests) | PASS |
| `npm run typecheck` | `TYPECHECK=PASS` |
| `npm run build` | `BUILD=PASS` |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| `git diff --check` | clean |
| Full suite | 9 failed files / 21 failed / **907 passed** / 25 skipped (953) |

### Full-suite classification

The 9 failing files are the pre-existing environmental family, each verified to
fail identically on the untouched baseline: `launchd-deterministic`,
`launchd-fail-closed` (provider binaries unresolvable), `preflight-config`,
`preflight-malformed`, `preflight-matrix` (5 s timeouts of an unmodified script),
`cavoti-persistent-runtime` (macOS Keychain), `claude-adapter` (5 s timeout),
and the three `publication/*` files (git/remote infrastructure). No timeout was
raised, no test skipped, and no assertion weakened.

**One remediated failure worth recording.** During this work
`legacy-code-router-compat` reported a failure whose assertion no longer existed
in the working tree. Root cause: the publication tests build a candidate from a
**committed** revision and run the suite there, so an *uncommitted* test fix was
legitimately failing inside that clone, and its output surfaced in the parent
log. Committing the fix (`805aff7`) removed it. This is a real property of the
suite, not a flake, and is recorded so a future reader does not chase it.

## 9. Final markers

```text
START_HEAD=27650ab5d3bf319c99cb51810160ec024f9b1395
END_HEAD=see run report

CORE_HARNESS_AGNOSTIC=YES
AUTH_HARNESS_AGNOSTIC=YES
BROKER_HARNESS_AGNOSTIC=YES
MODEL_ROUTING_HARNESS_AGNOSTIC=YES
CLIENT_METADATA_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

OPENAI_CHAT_COMPAT=PASS
OPENAI_RESPONSES_COMPAT=PASS
ANTHROPIC_MESSAGES_COMPAT=PASS

FUNCTION_TOOL_ROUNDTRIP=PASS
NAMESPACE_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
HOSTED_TOOL_CAPABILITY=EXPLICIT_UNSUPPORTED
UNKNOWN_TOOL_KIND=FAIL_CLOSED

CAPABILITY_PUBLICATION_TRUTHFUL=PASS
LEGACY_WIRE_ALIASES=EXPLICIT_COMPAT_ONLY

CMMCHAT_CHAT_ONLY=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE

NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
TRACKED_SECRETS=NONE

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

NEXT=INDEPENDENT_PROTOCOL_EXTENSIBILITY_AUDIT
```

## 10. Remaining gaps (truthful)

- **`namespace` tool declarations are still `EXPLICIT_UNSUPPORTED`.** A generic,
  reversible, collision-safe flattening design is required before they can be
  supported; until then they are refused by name.
- **`hosted`/provider-side tools are `EXPLICIT_UNSUPPORTED`** and should stay so
  unless a separate security design changes `CLIENT_OWNS_TOOLS`.
- **Real-client gates are unchanged** from the previous evidence: Qoder blocked on
  UI registration, Hermes manual, Codex blocked by the namespace class above.
  The Codex *configuration* path and the `developer`-role gap are now handled
  generically.
- **Task 16 / 16B** remain blocked on the richer `x_cmm`/`runtimeCapabilities`
  schema, which is out of scope here.
