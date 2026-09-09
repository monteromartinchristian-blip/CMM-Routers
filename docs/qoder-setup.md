# Qoder Setup — CMM Subscription Router

Qoder connects to the router as a single OpenAI-compatible provider.

## Router endpoint

```text
Provider: CMM Subscription Router
Type: OpenAI Compatible
Base URL: http://127.0.0.1:8790/v1
API key: local router bearer token (CMM_ROUTER_TOKEN)
```

The bearer token lives only in the machine-local environment.
Never commit it.

## Start the router

```bash
bash scripts/preflight.sh
npm run build
npm start
```

Expected bind:

```text
127.0.0.1:8790
```

Never `0.0.0.0`.

## Validate from the shell first

```bash
curl -s \
  -H "Authorization: Bearer $CMM_ROUTER_TOKEN" \
  http://127.0.0.1:8790/v1/models | python3 -m json.tool
```

Expected: dynamically discovered namespaced models
(`chatgpt/*`, `claude/*`, `google/*`, `command-code/*`).

## Smoke test

```bash
CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh
```

## Qoder validation order

1. Chat Completions first.
2. Add Responses only after Chat passes Qoder validation.

## Qwen Token Plan

Qwen remains native in Qoder. No router namespace exists for Qwen.
The router must never disturb the existing Qwen configuration.

## Tool capability truth table (v1)

All provider routes report `CHAT_ONLY_PENDING_TASK_13` until Task 13
proves external tool ownership per route. Where a route remains
chat-only, Qoder Agent-mode tool acceptance is
`TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY` — do not fake it.
