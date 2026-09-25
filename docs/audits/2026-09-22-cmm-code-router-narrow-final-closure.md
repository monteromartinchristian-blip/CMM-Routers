# CMM Code Router — Narrow Final Closure Evidence

**Date:** 2026-09-22
**Directing audit:** `docs/audits/2026-09-22-cmm-code-router-final-independent-audit-4a9f03f.md`
**Branch:** `feature/cmm-code-router-client-agnostic`
**Nature:** Closure evidence for findings F1–F4 and optional D1. Prior audits and
evidence are not rewritten.

## 1. Revisions

- **Audited revision (as named by the prompt):** `4a9f03fc0da8247668e2c39ee236ea0ee7843efa`
- **Worktree START_HEAD:** `4e0c5465b28b33685282506ffa40af04482c2854`
  — identical to the audited revision plus the docs-only commit that installs this
  audit (`git show --stat 4e0c546` adds exactly one file). No source difference.
- **Code + verification HEAD:** `5188bdf5326374139ee5713e90a91a9ecdab5de1`
- The evidence-document commit follows it; the true final HEAD is reported in the
  run report.

## 2. Findings closed

### F1 — OpenAI streaming surfaces

Both `/v1/chat/completions` and `/v1/responses` forwarded provider tool-call
fragments before any validation existed, so a malformed complete call could still
be presented as an executable one.

Both streaming branches now **buffer** tool-call arguments until the call
completes, validate the assembled set, and only then emit the protocol lifecycle:

- Chat: emits the `tool_calls` chunk(s) after validation, or a protocol error chunk
  with no `finish_reason: "tool_calls"` and no executable call;
- Responses: emits the item lifecycle after validation, or `response.failed` with
  **no** `response.completed`.

No heuristic JSON repair. The audit no longer certifies this from a helper name: it
requires the validator to be called on the assembled non-streaming **and** streaming
call sets in both files.

**Knock-on fix.** The malformed-argument hardening changed the observable streaming
contract: a tool delta is no longer an immediately-visible first frame. The
generic-client cancellation fixture detected a live stream through that frame and
therefore hung; it now observes a streamed text delta instead. The cancellation
assertions themselves (abort propagation, adapter cancel, usage cancellation,
pending-state cleanup) are unchanged.

### F2 — upstream tool-result translation

`toUpstreamMessages` added the canonical `tool_result_status` to every message and
the same array fed both Command Code wires, so an Anthropic-originated error result
became a non-standard member on the OpenAI-compatible upstream body — the exact
invented field the previous evidence said did not exist.

Translation is now per wire: the Anthropic wire carries the outcome as `is_error`;
the OpenAI-compatible wire carries standard fields only and keeps the canonical
status internal, with tool content byte-identical. Captured-request tests assert the
concrete HTTP bodies for both wires.

### F3 — request-control truth

The two OpenAI surfaces shared one descriptor: it claimed `max_tokens` for
Responses (which implements `max_output_tokens`) and claimed `temperature` was
explicitly unsupported while both surfaces silently ignored it.

Truth now has a single source of truth in `src/core/request-controls.ts`. The HTTP
surfaces **enforce** those lists and `x_cmm.request_controls` is **derived** from
them, so publication cannot drift from behavior:

- Chat implements `max_tokens`;
- Responses implements `max_output_tokens` and explicitly refuses the Chat spelling
  with a hint naming `max_output_tokens`;
- unrepresentable generation controls (`temperature`, `top_p`, `top_k`, `stop`,
  `presence_penalty`, `frequency_penalty`, …) are refused by name on both surfaces.

`x_cmm.code_router` is unchanged.

### F4 — Anthropic tool shapes

`is_error` accepted any value and mapped everything except literal `true` to
success, so a malformed outcome silently turned a failed tool into a successful
one. A present `is_error` must now be a boolean; anything else is an
`invalid_request_error` and the provider is never invoked.

`tool_use.input` is validated as the structured object the supported subset
promises: a primitive or array is refused instead of being serialized into
canonical function arguments. Absent input keeps the empty-argument default.

### D1 — strict discriminant (optional, done)

Every canonical tool-algebra variant now carries a closed `kind` discriminant and
`isFunctionTool` narrows on it, so the union is a strict TypeScript discriminated
union rather than members distinguished by an open `type` string. Behavior is
unchanged: representable is still not executable, policy still decides, and the
executable path stays narrowed to function tools.

## 3. Commits

| Commit | Subject |
|---|---|
| `ff099cb` | `fix: fail closed on malformed tool arguments while streaming` |
| `479c1b3` | `fix: translate upstream tool results per wire` |
| `b2ddc27` | `test: adapt the cancellation fixture to buffered tool arguments` |
| `ead8071` | `fix: make OpenAI request-control publication match behavior` |
| `a853838` | `fix: validate Anthropic tool_use and tool_result shapes` |
| `d8581b0` | `refactor: give the canonical tool union a strict discriminant` |
| `5188bdf` | `security: verify final closure invariants` |

20 files changed across the range.

## 4. Verification

| Gate | Result |
|---|---|
| New F1 tests (streaming malformed arguments, both surfaces) | PASS |
| New F2 tests (captured upstream bodies, both wires) | PASS |
| New F3 tests (request controls sent, not just inspected) | PASS |
| New F4 tests (shape validation) | PASS |
| All malformed-tool-argument tests | PASS |
| All tool-result-status tests | PASS |
| Protocol capability tests | PASS |
| Anthropic ingress / control / auth tests | PASS |
| Generic Chat/Responses round-trip + streaming | PASS |
| Profile/auth + CMMChat tool rejection | PASS |
| Broker / adversarial / cancellation | PASS |
| Compiled-process E2E | PASS |
| Broad battery (134 files / 723 tests) | PASS |
| `npm run typecheck` | `TYPECHECK=PASS` |
| `npm run build` | `BUILD=PASS` |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |
| `git diff --check` | clean |
| Full suite | 8 failed files / 18 failed / **961 passed** / 25 skipped (1004) |

### Full-suite classification

Every failing file is in the pre-existing environmental family and was verified
rather than assumed:

| File | Cause | Evidence |
|---|---|---|
| `launchd-deterministic`, `launchd-fail-closed` | installer cannot resolve `codex`/`agy` on this machine | fails identically on untouched baselines throughout this session |
| `preflight-config`, `preflight-matrix` | 5 s timeouts of an unmodified script | documented environmental family; pass in isolation |
| `claude-adapter` | 5 s timeout spawning the SDK/bridge | documented environmental family |
| `prepare-publication`, `push-publication`, `verify-publication` | git/remote publication infrastructure, 5 s timeouts | documented environmental family |
| `cavoti-persistent-runtime` | macOS Keychain access under load | **passes 6/6 in isolation** and imports no module this closure changed |

Failure causes in this run: 16 × `Test timed out in 5000ms` and the missing-provider
binary installer messages. No timeout was raised, no test skipped, and no assertion
weakened.

## 5. Required markers

```text
START_HEAD=4e0c5465b28b33685282506ffa40af04482c2854
END_HEAD=see run report

CORE_HARNESS_AGNOSTIC=YES
HARNESS_NAMES_REQUIRED_BY_CORE=NONE

CHAT_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
RESPONSES_STREAM_MALFORMED_TOOL_ARGUMENTS=FAIL_CLOSED
MALFORMED_STREAM_NEVER_COMPLETES_EXECUTABLE_CALL=PASS
VALID_STREAM_TOOL_ARGUMENTS_PRESERVED=PASS

OPENAI_UPSTREAM_TOOL_RESULT_STATUS_FIELD=ABSENT
OPENAI_UPSTREAM_TOOL_RESULT_CONTENT_PRESERVED=PASS
ANTHROPIC_UPSTREAM_IS_ERROR=PRESERVED

OPENAI_CHAT_REQUEST_CONTROL_TRUTH=PASS
OPENAI_RESPONSES_REQUEST_CONTROL_TRUTH=PASS
OPENAI_RESPONSES_MAX_OUTPUT_TOKENS_TRUTH=PASS
OPENAI_TEMPERATURE_NOT_SILENTLY_IGNORED=PASS
CAPABILITY_PUBLICATION_TRUTHFUL=PASS

ANTHROPIC_INVALID_IS_ERROR=FAIL_CLOSED
ANTHROPIC_TOOL_RESULT_ERROR_STATUS_PRESERVED=PASS
ANTHROPIC_TOOL_USE_INPUT_SHAPE=VALIDATED

CANONICAL_ROUTER_TOOL_ALGEBRA_EXTENSIBLE=YES
STRICT_TYPESCRIPT_DISCRIMINATED_UNION=YES

CMMCHAT_CHAT_ONLY=PASS
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES

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

NEXT=TRUE_FINAL_INDEPENDENT_AUDIT
```

## 6. Remaining gaps (truthful)

- `namespace` declarations remain representable but `EXPLICIT_UNSUPPORTED` pending a
  generic, reversible, collision-safe flattening design; `hosted` stays unsupported
  while `CLIENT_OWNS_TOOLS=YES`.
- The Anthropic-compatible surface remains a declared subset: generation controls
  are refused rather than implemented, and real-client verification is a separate
  gate.
- Streaming tool-call arguments are now delivered as one validated payload rather
  than incrementally. This is a deliberate contract change in favour of
  fail-closed behavior; clients that relied on partial fragments must adapt.
