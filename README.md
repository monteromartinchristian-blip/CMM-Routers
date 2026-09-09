# CMM Subscription Router

Local-first OpenAI-compatible router. Qoder consumes paid subscriptions
(ChatGPT/Codex, Claude, Google AI Pro/Antigravity, Command Code) through
one stable endpoint. No PAYG fallback. No cross-provider fallback.
Qoder is the sole tool executor. Qwen stays native in Qoder.

## Architecture

```text
Qoder → http://127.0.0.1:8790/v1 → ProviderRegistry → adapter → subscription transport
```

- `src/core/` — provider contract, model/request types, normalized events,
  stable errors, remote-worker wire contract.
- `src/http/` — Fastify server, Chat Completions, Responses API, SSE,
  diagnostics (`/v1/cmm/*`).
- `src/providers/codex/` — ChatGPT via `codex app-server` JSON-RPC.
- `src/providers/claude/` — Claude via Agent SDK, isolated profile.
- `src/providers/antigravity/` — Google via `agy` headless stream-json.
- `src/providers/command-code/` — GOAT via Provider API + spend guard.
- `src/registry/` — dynamic discovery, exact namespace resolution.
- `src/security/` — bearer auth, redaction, PAYG guard.
- `src/observability/` — local-only usage store.
- `src/config/` — shared/local config, machine id.

## Installation

```bash
npm install
npm run build
bash scripts/preflight.sh
npm start
```

Binds only `127.0.0.1:8790`. Never `0.0.0.0`.

## Provider setup

| Provider | Auth | Models | PAYG guard |
|---|---|---|---|
| chatgpt | `codex login` (ChatGPT) | dynamic via app-server | `OPENAI_API_KEY` must be absent |
| claude | isolated profile (`CLAUDE_CONFIG_DIR`) | dynamic via SDK | `ANTHROPIC_*` stripped |
| google | Google account via `agy` | dynamic via `agy models` | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL` stripped |
| command-code | `COMMAND_CODE_SECRET` + GOAT spend ack | dynamic via Provider API | ack file required, no on-demand fallback |

Command Code additionally requires the machine-local spend acknowledgement
(`command-code-spend-ack.json`, git-ignored):

```json
{"version": 1, "plan": "GOAT", "autoTopUpDisabled": true, "allowOnDemandCredits": false}
```

Do not create it on anyone's behalf. It is a human attestation.

## Model namespaces

`chatgpt/*`, `claude/*`, `google/*`, `command-code/*`.
Unknown prefixes fail closed. No aliases unless declared in shared config.

## Qoder setup

See `docs/qoder-setup.md`. Base URL `http://127.0.0.1:8790/v1`,
local bearer token, Chat first, Responses after Chat passes.

## PAYG policy

Startup refuses when forbidden variables are present
(`src/security/payg-guard.ts`). Every provider strips its PAYG variables
from child environments. Command Code additionally refuses any spend path
(`/extra`, top-up, purchase) and any on-demand-credit fallback.

## Local secret policy

Secrets live in the environment or macOS Keychain, never in Git, logs,
snapshots, fixtures, or synced config. `config/local.json` is git-ignored.

## MacBook / iMac setup

See `docs/macos-install.md`. Same revision both Macs, independent local
auth and secrets, offline-capable.

## Troubleshooting

- `401 router_unauthorized` — wrong/missing `CMM_ROUTER_TOKEN`.
- `provider_auth_required` — run the provider login for that route.
- `provider_quota_exhausted` — plan quota spent; never auto-falls back.
- `unknown_model` — model not in live discovery; check `/v1/models`.
- Antigravity `modelProvider=gemini` — STOP, would route to Gemini API.
- Antigravity `useG1Credits=true` — STOP, would spend AI Credits.

## Provider limitations (v1, observed 2026-09-09)

- Codex app-server: subscription auth, read-only sandbox per turn.
- Claude SDK 0.3.266: completion signaled by `result/success`, not
  `stop_reason`; models are aliases (`sonnet`, `opus`, `haiku`, `default`).
- agy 1.1.16: `--print-timeout` needs a duration unit (`120s`);
  stream-json envelope is `{"event": type, type: {...}}`;
  `agy models` has no JSON flag; settings file gains `trustedWorkspaces`
  entries owned by the CLI itself.
- Command Code Provider API: live use blocked until spend ack + secret
  preconditions are human-confirmed (`BLOCKED_EXTERNAL_PRECONDITION`).
- All routes: `CHAT_ONLY` — external tool ownership unproven per route;
  `TOOL_ACCEPTANCE=BLOCKED_PROVIDER_CAPABILITY` (Task 13 closure).

## Tool capability truth table

| Route | Capability | External tools |
|---|---|---|
| chatgpt/* | CHAT_ONLY | BLOCKED |
| claude/* | CHAT_ONLY | BLOCKED |
| google/* | CHAT_ONLY | BLOCKED |
| command-code/* | CHAT_ONLY | BLOCKED |

## Preflight

```bash
bash scripts/preflight.sh
```

Prints status only, never secret values. Fails the run on unsafe PAYG
state. See Task 15 report fields in `scripts/preflight.sh`.
