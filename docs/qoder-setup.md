# Qoder Setup — CMM Routers

Qoder is the first documented consumer of the **CMM Code Router** profile: it
connects to the router as a single OpenAI-compatible provider, and Qoder itself
owns and executes any tool the provider requests. The provider reasons; Qoder
acts.

Qoder is a supported client of CMM Routers — it is not the identity of the
project or of the profile.

## Router endpoint

```text
Provider: CMM Routers
Type: OpenAI Compatible
Base URL: http://127.0.0.1:8790/v1
API key: local router bearer token (CMM_ROUTER_TOKEN)
```

The Qoder provider ID registered locally is `qoder-custom-cmm-router`. That is a
**legacy compatibility identifier**, intentionally retained so an already
registered Qoder provider keeps resolving after the product rename. Do not
re-register under a new ID for cosmetic reasons.

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
(`chatgpt/*`, `claude/*`, `google/*`, `command-code/*`), each carrying its own
advertised capability.

## Smoke test

```bash
CMM_ROUTER_TOKEN=<token> bash scripts/qoder-smoke.sh
```

## Qoder validation order

1. Chat Completions first.
2. Add Responses only after Chat passes Qoder validation.

## Model metadata requires a full Qoder restart

If you modify `~/.qoder/settings.json` outside Qoder — for example to refresh
model metadata that the router now advertises — **Qoder must be fully quit and
relaunched** before its UI reflects the change. Reloading a window is not
sufficient; the model metadata is read at application startup.

Do not expose, print, or commit `~/.qoder/settings.json`. It may contain
plaintext credentials. Refresh it through the supported provider-registration
path rather than by sharing its contents.

## Qwen Token Plan

Qwen remains native in Qoder. No router namespace exists for Qwen.
The router must never disturb the existing Qwen configuration.

## Tool capability

Qoder Agent-mode tool calls are supported on routes whose provider and model
truthfully support the externally-owned tool round-trip; those routes advertise
`CHAT_AND_TOOLS`. The router surfaces the structured tool call to Qoder and
never executes it, and a continuation carrying Qoder's result re-enters the same
logical provider run.

A route only advertises `CHAT_AND_TOOLS` where that round-trip is implemented and
proven. Where a provider genuinely cannot hand a tool call to the harness, the
route reports the limitation instead of claiming a capability it cannot honour.
Command Code is currently disabled in the active runtime, so its routes are not
served until it is explicitly enabled.

See `docs/qoder-acceptance.md` for the acceptance criteria and the recorded
verification state.
