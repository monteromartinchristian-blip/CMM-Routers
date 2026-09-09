# Qoder Router Acceptance

**Date:** 2026-09-09
**Router HEAD:** 7c7a2e5 (Task 15) — updated through overnight run
**Status:** `BLOCKED_EXTERNAL_PRECONDITION` (direct Qoder UI automation
unavailable in this environment)

## Router-side acceptance harness

The router side is fully testable without the Qoder UI:

- `POST /v1/chat/completions` non-streaming: PASS (mocked providers)
- `POST /v1/chat/completions` SSE streaming ending with `data: [DONE]`: PASS
- `POST /v1/responses` object + streaming events: PASS
- Provider failure isolation (one provider fails, router stays up): PASS
- No cross-provider fallback: PASS (registry resolves exact namespace only)
- Cancellation reaching the provider adapter: PASS (per-provider tests)
- Tool-call normalization to OpenAI `tool_calls` shape: PASS (mocked)
- Live provider tool-boundary probes: PASS for chatgpt/claude/google
  (all `CHAT_ONLY_NO_TOOL_EMITTED`), command-code skipped (no models
  without ack+secret), workspace mutation `BLOCKED`

Run:

```bash
bash scripts/preflight.sh
npm test -- tests/http/openai-chat.test.ts tests/http/openai-responses.test.ts
CMM_RUN_LIVE=1 npm test -- tests/integration/tool-roundtrip.integration.test.ts
CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh
```

## UI acceptance (blocked, external precondition)

Direct Qoder UI automation is unavailable here, so the following are
`BLOCKED_EXTERNAL_PRECONDITION`, not claimed:

- Qoder chat against `http://127.0.0.1:8790/v1`
- Qoder streaming display
- Qoder Agent-mode tool call → Qoder executes → router forwards result
- Qoder-initiated repository edit with provider-side non-mutation
- Qwen native regression inside the Qoder UI

Exact Qoder setup instructions: see `docs/qoder-setup.md`.

## Qwen regression

No router namespace exists for Qwen. The router contains no Qwen code
path and cannot disturb the native Qwen Token Plan configuration.
UI-level confirmation remains with the human.

## Tool acceptance per route

All routes report `CHAT_ONLY_PENDING_TASK_13`:

```text
TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY
```

for every provider until an external tool-ownership round trip is
proven per route. No tool support is faked.
