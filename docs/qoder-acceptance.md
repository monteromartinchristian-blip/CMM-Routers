# Qoder Router Acceptance — CMM Routers

This is the **current** acceptance record for Qoder against CMM Routers. Qoder
is the first documented consumer of the `CMM Code Router` profile, in which the
provider reasons and Qoder owns tool execution.

Earlier acceptance snapshots dated 2026-09-09 described a pre-promotion state in
which every route was `CHAT_ONLY`. That history is preserved in the audit
evidence under `docs/audits/` and in `docs/task-13-closure.md`, which keep the
names and capability states that were accurate at the time. This file describes
the present.

## Capability summary

Qoder consumes routes that advertise `CHAT_AND_TOOLS`. The router surfaces each
structured tool call to Qoder and never executes it; a continuation carrying
Qoder's result re-enters the same logical provider run.

| Route | Capability | Externally-owned tools |
|---|---|---|
| `chatgpt/*` | `CHAT_AND_TOOLS` | Proven (deterministic + authorized live canary) |
| `claude/*` | `CHAT_AND_TOOLS` | Proven (deterministic + authorized live canary) |
| `google/*` | `CHAT_AND_TOOLS` | Proven (deterministic + authorized live canary) |
| `command-code/*` | `CHAT_AND_TOOLS` (when enabled) | Wired and deterministically covered; provider ships disabled, live enablement open under Task 15 |

Command Code is intentionally disabled in the active runtime. It is not served
until it is explicitly enabled with a human spend acknowledgement, so no live
Command Code tool round-trip is claimed here.

## Router-side acceptance harness

The router side is fully testable without the Qoder UI:

- `POST /v1/chat/completions` non-streaming: PASS (mocked providers)
- `POST /v1/chat/completions` SSE streaming ending with `data: [DONE]`: PASS
- `POST /v1/responses` object + streaming events: PASS
- Provider failure isolation (one provider fails, router stays up): PASS
- No cross-provider fallback: PASS (registry resolves exact namespace only)
- Cancellation reaching the provider adapter: PASS (per-provider tests)
- Tool-call normalization to OpenAI `tool_calls` shape: PASS (mocked)
- Declared-tool ACL: an undeclared tool is never callable: PASS
- Provider-side non-mutation: the provider reasons, it never edits a repository

Run the deterministic acceptance suite:

```bash
bash scripts/preflight.sh
npm test -- tests/http/openai-chat.test.ts tests/http/openai-responses.test.ts
npm test -- tests/integration/tool-roundtrip.integration.test.ts
CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh
```

The live provider tool-boundary canaries consume subscription quota, so they are
separate, explicit, and gated. They never run as part of a normal test pass.

## Live tool round-trip (authorized canaries)

The full Qoder-owned round-trip — provider reasoning → declared tool request →
Qoder-owned execution → unpredictable result-only nonce → correlated tool result
→ provider continuation → final answer derived from the nonce — was proven on
2026-09-11 for `google/*` and `chatgpt/*`, and preserved for `claude/*` from
earlier authorized runs. Recorded evidence:

- `docs/audits/2026-09-10-task13-protocol-truth-production-wiring-evidence.md`
- the Task 13 / Task 14 live-canary evidence bundles referenced from
  `docs/task-13-closure.md` and `docs/task-14-codex-post-tool-continuation.md`

Those evidence artifacts keep their historical names, which were accurate under
the project's earlier identity.

## UI acceptance (blocked, external precondition)

Direct Qoder UI automation is unavailable in this environment, so the following
remain `BLOCKED_EXTERNAL_PRECONDITION` rather than claimed here:

- Qoder chat against `http://127.0.0.1:8790/v1`
- Qoder streaming display
- Qoder Agent-mode tool call → Qoder executes → router forwards result
- Qoder-initiated repository edit with provider-side non-mutation
- Qwen native regression inside the Qoder UI

Exact Qoder setup instructions: see `docs/qoder-setup.md`.

If `~/.qoder/settings.json` is edited outside Qoder, Qoder must be fully quit and
relaunched before its UI reflects the updated model metadata.

## Qwen regression

No router namespace exists for Qwen. The router contains no Qwen code path and
cannot disturb the native Qwen Token Plan configuration. UI-level confirmation
remains with the human.
