# CMM Subscription Router — Design Specification

**Date:** 2026-09-09
**Status:** Proposed v1
**Scope:** Qoder-facing subscription router for ChatGPT/Codex, Claude, Google AI Pro/Antigravity, and Command Code. Qwen remains native in Qoder.

## 1. Goal

Build a local-first, OpenAI-compatible routing service that lets Qoder use multiple already-paid AI subscriptions through one stable endpoint, without exposing OAuth tokens to Qoder and without silently falling back to pay-as-you-go APIs.

The system must be portable between the MacBook and iMac and must support a future distributed/cloud deployment without redesigning provider adapters.

## 2. Non-goals for v1

- No automatic model selection.
- No cross-provider fallback.
- No API PAYG fallback.
- No Qwen proxying while Qoder already supports the Token Plan natively.
- No shared OAuth-token files between computers.
- No public Internet exposure of local workers.
- No provider-native filesystem/shell tools behind Qoder.

## 3. External interface

Qoder sees one provider:

- Protocol: OpenAI-compatible
- Base URL: `http://127.0.0.1:8790/v1`
- Authentication: router-generated local bearer secret
- Model IDs: provider-namespaced

Required endpoints:

- `GET /health`
- `GET /ready`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

CMM diagnostic endpoints:

- `GET /v1/cmm/providers`
- `GET /v1/cmm/health`
- `GET /v1/cmm/usage`

## 4. Provider namespaces

Model routing is explicit:

- `chatgpt/*` → Codex adapter
- `claude/*` → Claude adapter
- `google/*` → Antigravity adapter
- `command-code/*` → Command Code adapter

Unknown prefixes fail closed.

Model discovery is dynamic. The registry may cache discovery results briefly, but it must not invent unavailable model IDs.

## 5. Provider adapters

### 5.1 ChatGPT / Codex

Backend: official `codex app-server`.

Authentication:
- Sign in with ChatGPT.
- Credentials remain under Codex/OS secure storage.
- Router never reads or copies OAuth tokens.

Transport:
- Spawn and supervise `codex app-server`.
- Communicate using its JSON-RPC protocol.
- Translate Qoder requests/tool schemas into Codex model turns and normalize streamed responses back into OpenAI-compatible output.

Safety:
- Qoder remains the tool executor.
- Codex-native filesystem/shell execution is disabled for routed requests.
- No OpenAI API-key fallback.

### 5.2 Claude

Backend: Claude Agent SDK / supported Claude subscription authentication.

Authentication:
- Dedicated CMM Router Claude profile.
- Isolated from the user's existing Claude Code / OmniRoute configuration.
- Router never copies OAuth material.

Transport:
- Use the Agent SDK as the subscription-backed model transport.
- Normalize message, streaming, tool-call, stop-reason, and error semantics.

Safety:
- Provider-native file/shell tools disabled for routed requests.
- No `ANTHROPIC_API_KEY` fallback.
- If subscription-backed use is unavailable, fail closed.

### 5.3 Google AI Pro / Antigravity

Backend: official `agy` CLI in headless mode.

Authentication:
- Google account / OS keyring credentials.
- No `GEMINI_API_KEY` fallback.

Transport:
- Use `agy` headless with machine-readable JSON/stream-json.
- Pin the requested model explicitly.
- Parse streaming events into router events.

Safety:
- No `--dangerously-skip-permissions`.
- No native write/shell permissions for routed Qoder calls.
- Unknown model or unavailable quota fails loudly.

### 5.4 Command Code

Backend v1: official Command Code Provider API.

Authentication:
- Command Code provider secret stored only in local OS secure storage / environment supplied to the service.
- Never committed or synchronized.

Transport:
- Prefer the provider's OpenAI-compatible surface where possible.
- Preserve tool schemas, streaming, model selection, and provider errors.

Future adapter:
- Optional Command Code CLI/headless adapter behind the same internal interface.

## 6. Internal provider contract

Every provider adapter implements the same logical contract:

- `id`
- `discoverModels()`
- `health()`
- `createChatCompletion(request, signal)`
- `createResponse(request, signal)`
- `cancel(requestId)`
- normalized error mapping
- normalized usage metadata where available

Provider-specific process, OAuth, SDK, or HTTP details must not leak into routing or Qoder-facing layers.

## 7. Request flow

1. Qoder sends a request to the router.
2. Router authenticates the local client.
3. Router validates the model namespace.
4. Model registry resolves one provider and one exact upstream model.
5. Router forwards the request to that provider adapter.
6. Adapter streams normalized text/tool/reasoning events.
7. Router emits OpenAI-compatible streaming/non-streaming output.
8. If the provider fails, the router returns a normalized error.
9. No other provider is tried automatically.

## 8. Tool ownership

Qoder is the sole tool executor for routed requests.

Allowed:
- Qoder sends tool definitions.
- Provider requests a tool call.
- Router returns the normalized tool call.
- Qoder executes it.
- Qoder submits the result.

Disallowed:
- Codex, Claude, Antigravity, or Command Code independently editing the repository.
- Hidden shell execution by a provider adapter.
- Provider-native autonomous workspace mutation.

## 9. Security invariants

Mandatory:

- Bind standalone router to `127.0.0.1`.
- Require a locally generated router bearer secret.
- Never log Authorization headers, OAuth tokens, provider secrets, prompts by default, file contents, or tool results.
- No OAuth-token extraction, copying, synchronization, or export.
- No API PAYG fallback.
- No cross-provider fallback.
- Exact model pinning.
- Unknown models fail.
- Provider quota exhaustion returns an explicit error.
- Secrets never enter Git or iCloud configuration sync.
- Startup must detect conflicting PAYG environment variables and either unset/ignore them by provider policy or refuse startup.

## 10. Multi-computer design

The MacBook and iMac run the same codebase and declarative non-secret configuration.

Shared/synchronizable:
- provider enablement
- model aliases
- Qoder-facing labels
- ports
- logging policy
- feature flags
- schema versions

Machine-local only:
- ChatGPT/Codex authentication
- Claude authentication
- Google/Antigravity authentication
- Command Code secret
- router bearer secret
- runtime sockets/PIDs/cache

Each Mac performs its own provider login.

A machine identifier is generated locally so diagnostics can distinguish:
- `macbook`
- `imac`
without embedding usernames or home paths in shared configuration.

## 11. Deployment modes

### 11.1 Standalone mode — v1 target

Each Mac runs:

`Qoder → local router → local provider adapters`

Advantages:
- simplest
- lowest latency
- credentials never leave machine
- works offline from the other Mac
- no remote attack surface

### 11.2 Distributed mode — planned compatibility

Split into:

**Router / control plane**
- exposes the Qoder-compatible API
- model registry
- routing
- health aggregation
- no provider OAuth tokens required

**Workers**
- run next to authenticated provider CLIs/SDKs
- execute provider adapter calls
- return normalized events
- authenticate mutually to the router

A request may therefore be:

`Qoder on MacBook → router → iMac worker → provider`

This enables the iMac to act as an always-on subscription worker while the MacBook remains lightweight.

### 11.3 Cloud mode — future

Supported topology:

`Qoder → private cloud router → authenticated private workers`

Workers may be:
- MacBook
- iMac
- a remote Linux host where the provider officially supports account authentication

Cloud constraints:
- OAuth/token profiles are not uploaded merely to centralize the router.
- Workers establish outbound authenticated connections where practical.
- No provider worker is exposed directly to the public Internet.
- Use a private transport such as a mutually authenticated tunnel/overlay network.
- Cloud deployment must retain the same fail-closed PAYG and model-pinning guarantees.

Google Antigravity is explicitly compatible with remote SSH OAuth authentication. Other providers must be enabled remotely only where their supported authentication/runtime permits it.

## 12. Configuration model

Two layers:

### Shared config
Version-controlled, contains no secrets.

Example concepts:
- enabled providers
- provider namespaces
- default ports
- per-provider timeout
- model aliases
- logging mode
- deployment mode

### Local config
Not synchronized and ignored by Git.

Contains references to:
- local credential profile names
- Keychain service/account identifiers
- machine identifier
- local worker certificate/key references
- optional process paths

Secrets themselves should live in secure OS storage whenever supported.

## 13. Observability

Default telemetry is local only.

Expose:
- provider readiness
- active model
- request count
- latency
- quota/rate-limit events where upstream exposes them
- last successful request timestamp
- adapter/process health

Do not expose:
- prompts
- completions
- source files
- OAuth tokens
- API keys
- raw Authorization headers

## 14. Error normalization

Required stable categories:

- `invalid_request`
- `unknown_provider`
- `unknown_model`
- `provider_unavailable`
- `provider_auth_required`
- `provider_quota_exhausted`
- `provider_rate_limited`
- `provider_timeout`
- `provider_protocol_error`
- `router_unauthorized`
- `router_internal_error`

Errors include provider namespace and safe diagnostic metadata, never credentials.

## 15. Process supervision

Standalone v1 must support macOS launchd eventually, but initial validation runs manually.

The supervisor must:
- start required child processes
- detect unexpected exit
- expose degraded readiness
- terminate children on shutdown
- avoid restart storms
- never silently switch authentication mode

## 16. Testing strategy

### Unit
- namespace routing
- model registry
- error mapping
- secret redaction
- request/stream normalization
- PAYG-fallback prevention

### Contract
Mock each provider and verify:
- text
- streaming
- tool calls
- tool results
- cancellation
- rate limits
- auth failure
- malformed upstream response

### Integration
Against authenticated local providers:
- Codex subscription request
- Claude subscription request
- Antigravity subscription request
- Command Code provider request

### Qoder acceptance
For every provider:
1. model validation succeeds
2. simple chat succeeds
3. streaming succeeds
4. tool call round-trip succeeds
5. repository edit initiated by Qoder succeeds
6. provider cannot mutate repository independently
7. quota exhaustion does not trigger PAYG or another provider

### Multi-machine acceptance
- same Git revision on both Macs
- independent local secrets
- independent provider auth
- same `/v1/models` schema
- router works if the other Mac is offline

## 17. Repository shape

Proposed repository:

`CMM-Subscription-Router`

Top-level shape:

- `src/core/`
- `src/http/`
- `src/providers/codex/`
- `src/providers/claude/`
- `src/providers/antigravity/`
- `src/providers/command-code/`
- `src/registry/`
- `src/security/`
- `src/observability/`
- `src/config/`
- `tests/`
- `docs/superpowers/specs/`
- `docs/superpowers/plans/`

Language: TypeScript on Node.js.

## 18. v1 completion criteria

v1 is complete only when:

- Qoder uses one router endpoint.
- ChatGPT/Codex works through subscription authentication.
- Claude works through isolated subscription authentication.
- Google Antigravity works through Google account authentication.
- Command Code works through its provider plan/API.
- Qwen remains unaffected and native in Qoder.
- No provider can silently enter PAYG mode.
- No OAuth token is copied into the router.
- Tool calls round-trip through Qoder.
- Router survives provider failure without crashing.
- Test suite passes.
- MacBook standalone setup is proven.
- iMac install procedure is reproducible with machine-local reauthentication.
- The internal provider contract is already suitable for a future remote worker transport.
