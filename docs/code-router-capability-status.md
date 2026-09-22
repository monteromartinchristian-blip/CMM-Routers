# CMM Code Router — Capability and Real-Client Status

**Date:** 2026-09-22
**Nature:** Current-facing status. Historical evidence under `docs/audits/` is not
rewritten by this document and may contain superseded wording.

This page states what is **proven**, what is **pending**, and what is
**blocked**. A client or provider is never marked passing on the strength of
mocked traffic or Router-side determinism alone.

## Model capability truth

CMM Code Router publishes a per-model Code Router verdict on `GET /v1/models`
inside the `x_cmm` namespace:

```json
{ "x_cmm": { "code_router": "CHAT_AND_TOOLS" } }
```

- Present only when the Router has already verified the capability; absent means
  *unverified*, which is treated as `CHAT_ONLY` for tool requests.
- Publication is a statement about the model, never an authorization grant: a
  `CHAT_ONLY` model still fails closed when tools are requested.
- Three concepts remain separate: **model discovered**, **capabilities
  verified**, and **local billing/entitlement**. Publication covers only the
  middle one.

`x_cmm` is the namespace the planned Task 16 capability-truth work also extends
(context window, output tokens, vision, reasoning). This work adds only the
`code_router` verdict and does not implement Task 16's schema.

## Provider status

| Provider route | Deterministic tool round trip | Real-client / live gate |
|---|---|---|
| `chatgpt/*` (Codex upstream) | Proven | Revalidation requires subscription quota — open |
| `claude/*` | Proven | Authorized live canary recorded earlier; re-proof pending |
| `google/*` (Antigravity) | Single-step proven; multi-step and GPT-OSS **not** proven | Open |
| `command-code/*` | Proven | Live completion requires an explicit human spend decision; disabled by default |
| `cavoti` | Proven | PAYG route; disabled by default and requires an explicit acknowledgement |

Earlier documents claimed `google/*` `CHAT_AND_TOOLS` as "Proven" without
qualification. That overstates the multi-step and GPT-OSS cases and is not
repeated here.

## Client status

| Client | Router-side deterministic contract | Real installed client |
|---|---|---|
| Generic OpenAI-compatible | Proven (Chat Completions + Responses, streaming, continuation, cancellation) | Architectural reference; no real client required |
| Qoder | Proven (legacy and canonical bearer) | **Blocked**: the `qoder-custom-cmm-router` provider is not present in the local Qoder settings and registering a custom provider requires the Qoder UI |
| Hermes | Proven (Chat Completions transport, discovery, structured streaming, tool round trip) | Live gate pending; the installed client supports a custom OpenAI-compatible provider |
| Codex CLI | Proven (Responses surface, exact model selection, tool ownership) | Live gate pending; the installed client accepts custom providers but **only** the Responses wire API, and performs no model discovery |

Real-client gates are allowed to be blocked by external conditions. A blocked
gate is not a Router failure and must not be reported as a pass.

## Task 16 / 16B dependency

Task 16 capability truth (`runtimeCapabilities`, richer `x_cmm`) is **not
implemented**. Task 16B (multi-Mac bidirectional Qoder model synchronization)
depends on a manifest derived from that richer `x_cmm`, so it remains blocked on
a prerequisite that does not exist yet. Neither is in scope for the Code Router
completion, and no rigid model layout is introduced in its place.

## Invariants

```text
CMMCHAT_CHAT_ONLY=PASS
CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS
CMM_CODE_ROUTER_CLIENT_AGNOSTIC=YES
CLIENT_OWNS_TOOLS=YES
PROVIDER_NATIVE_TOOL_EXECUTION=NONE
PROVIDER_NATIVE_REPO_MUTATION=NONE
NO_PAYG_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_UNKNOWN_MODEL_FALLBACK=YES
LOOPBACK_ONLY=YES
TRACKED_SECRETS=NONE
```
