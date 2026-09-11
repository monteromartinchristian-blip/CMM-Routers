# Task 13 — CLOSED

## Scope

Task 13 closed the Qoder-owned tool-calling architecture and provider remediation work for CMM Subscription Router.

Canonical closure HEAD:

`6b772f039197b030f90c906ec75b1f31cbef2207`

## Closure decision

**Status: CLOSED**

The Router implementation is independently verified and closure-eligible.

The remaining ChatGPT/Codex issue is not a confirmed Router defect. It is isolated to upstream `codex app-server` post-tool final-answer emission and has been transferred to Task 14.

Command Code is not considered a Task 13 defect. It is intentionally disabled in the current runtime and its future live enablement has been transferred to Task 15.

## Provider matrix at closure

| Provider | Task 13 status | Notes |
| --- | --- | --- |
| Claude | PASS — live proof preserved | Existing live canary PASS; not rerun |
| Google / Antigravity | PASS — live | Full Qoder-owned tool round-trip proven with scoped `mcp(cmm-qoder-tools/*)` permission |
| ChatGPT / Codex | Router PASS; upstream limitation transferred | Tool round-trip reaches same-thread/same-turn continuation, but `codex app-server 0.153.4` emits an empty final `agentMessage`; reproduced without the Router |
| Command Code | DISABLED_BY_DESIGN | Deterministic routing/tool semantics verified; no current live enablement |

### Post-closure correction (Task 14, 2026-09-11)

The ChatGPT/Codex row above is **corrected**: the empty post-tool final answer was
**not** an upstream `codex app-server` limitation. The Task 13 canary prompt
ordered `Do not answer in plain text` — a prohibition on the output under test —
and the "direct app-server reproduction" reused that same prompt, so it
reproduced the harness instruction rather than an independent provider defect.
Because the Codex continuation reuses the same provider turn, the prohibition was
still in context when the tool result arrived.

Task 14 corrected the prompt (ChatGPT-scoped) and the live
`chatgpt/gpt-5.6-sol` canary now PASSES the full round-trip with a non-empty
final answer causally derived from the Qoder result nonce. See
`docs/task-14-codex-post-tool-continuation.md`.

This is a factual correction only. **Task 13 remains CLOSED**; its closure
decision, its deterministic verification and its other provider results are
unaffected.


## Required guarantees

- `NO_PAYG_FALLBACK=YES`
- `NO_CROSS_PROVIDER_FALLBACK=YES`
- `NO_UNKNOWN_MODEL_FALLBACK=YES`
- `QODER_EXECUTION_OWNER=YES`
- `PROVIDER_NATIVE_REPO_MUTATION=NONE`
- `TRACKED_SECRETS=NONE`
- `PUSH_PERFORMED=NO`
- `DO_NOT_PUSH=YES`

## Independent evidence

Closure re-audit:

`CMM-Subscription-Router-task13-closure-reaudit-6b772f0-2026-09-11.txt`

The corresponding SHA-256 sidecar is stored beside it in the canonical iCloud Downloads evidence directory.

The independent re-audit reports:

- Blocker: 0
- Major: 0
- Minor: 0
- full deterministic suite ×2: 673 passed / 25 skipped
- security audit: PASS
- no-inference preflight: PASS
- clean repository state

## Transferred work

- Task 14 — Codex Post-Tool Continuation Compatibility
- Task 15 — Command Code Live Enablement and Subscription-Safe Canary

Task 13 must not be reopened merely because one of those follow-up tasks remains open.
