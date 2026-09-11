# Consumer Capability Policy — Task 13 (Qoder-Owned Tools)

**Status:** Adopted (implementation in progress)
**Scope:** How the Router decides whether a request may carry tool semantics.

## Problem

The Router previously treated every provider as `CHAT_ONLY` at the HTTP
boundary and rejected tool payloads for everyone. Task 13 requires two
different consumers:

```text
CMMChat → CHAT_ONLY (always, by design)
Qoder   → CHAT_AND_TOOLS where the provider genuinely supports it
```

Consumer identity must never be inferred from prompt text, User-Agent
strings, or model names, and the decision must be server-side and
configuration-controlled — never a remotely exploitable "enable tools" flag.

## Design

Two server-configured bearer tokens distinguish the consumers:

| Consumer | Token env var | Tool policy |
| --- | --- | --- |
| CMMChat (default) | `CMM_ROUTER_TOKEN` (existing `bearerSecretEnv`) | always `CHAT_ONLY` |
| Qoder (optional) | `CMM_QODER_TOKEN` | `CHAT_AND_TOOLS` only when the resolved model reports `CHAT_AND_TOOLS` |

Rules:

1. `buildServer` verifies the presented bearer against the default token first
   (CMMChat), then against the optional Qoder token. Exactly one consumer is
   attached to the request; a token matching neither is 401. When
   `CMM_QODER_TOKEN` is not configured, no client can be Qoder — tools remain
   impossible for everyone.
2. The effective capability is `consumer AND provider`:
   `effectiveToolCapability(consumer, model.capability)` returns
   `CHAT_AND_TOOLS` only for the Qoder consumer on a `CHAT_AND_TOOLS` model;
   every other combination is `CHAT_ONLY`.
3. `rejectChatOnlyTools` runs unchanged against the EFFECTIVE capability, so
   the existing fail-closed rejections (tools / tool_choice /
   parallel_tool_calls / tool-role messages / assistant tool-call history)
   still apply — now per consumer.
4. Capability truthfulness is preserved: a provider that merely understands
   tool-shaped HTTP traffic is not `CHAT_AND_TOOLS`; only providers with a
   complete proven structured upstream round-trip are promoted, per provider.

No per-request client claims (headers, body fields) can change the consumer;
identity is bound entirely to which configured secret validated.

## Files

- `src/core/consumer-capability.ts` — `CONSUMER_QODER`, `CONSUMER_CMMCHAT`,
  `effectiveToolCapability()`.
- `src/http/server.ts` — optional `ServerOptions.qoderToken`;
  `resolveConsumerId()` attaches the consumer in the `/v1/*` preHandler.
- `src/http/openai-chat.ts`, `src/http/openai-responses.ts` — gate tool
  semantics on the effective capability.
- `src/index.ts` — reads optional `CMM_QODER_TOKEN` into the server.
- `.env.example` — documents both token variable names (no values).
- `tests/http/consumer-capability.test.ts` — required Task 13 §1 tests.

## Required tests (Task 13 §1)

```text
CMMCHAT_TOOLS_REJECTED=PASS
QODER_TOOLS_ALLOWED_WHEN_PROVIDER_CAPABLE=PASS
UNAUTHENTICATED_TOOL_ESCALATION=NONE
CLIENT_CAPABILITY_SPOOFING=NONE
```
