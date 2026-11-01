# CMM Routers

> Use the AI subscriptions you already pay for, from the tools you actually want to use.

CMM Routers is a local-first, OpenAI-compatible router that connects AI
subscriptions you already pay for to the clients and harnesses you actually want
to work in. It exposes those subscriptions through one stable loopback endpoint
instead of forcing every client onto a separate metered API key.

The design is deliberately narrow: it routes. It does not resell access, does not
fall back to pay-as-you-go, and does not let a provider reach into your
repository.

## Profiles

One Router, one tool engine, two capability policies. A profile is an
authorization identity resolved from a server-side bearer before any request
field is read. It is never selected or changed by a header, body field, model
name, tool name, client name or claimed capability.

| Profile | Authenticated by | Intended consumer |
|---|---|---|
| `CHAT` | `CMM_ROUTER_TOKEN` | CMMChat and equivalent conversational clients |
| `AGENT` | `CMM_CODE_ROUTER_TOKEN` (canonical) or `CMM_QODER_TOKEN` (legacy Qoder alias) | Qoder, Hermes, Codex CLI, generic OpenAI-compatible agents, future CMM Cowork |

Both profiles share the same `ProviderRegistry`, HTTP/API surfaces, model
discovery, streaming, session handling, tool transport, tool correlation,
observability, security boundary and provider adapters. The difference is
exclusively the capability policy applied before a tool enters that pipeline.

### CHAT

The normal CMMChat profile: conversation, streaming, multimodal input where the
provider supports it, and reasoning.

- **No default tool access.** Sending a `tools` array does not grant anything.
- **Scoped actions only.** CHAT may use only actions that are both registered by
  the Router and explicitly granted by server-side policy. A registered action
  that was not granted is rejected; an invented tool is rejected; a mixed
  allowed + forbidden set is rejected as a whole. Nothing is silently stripped.
- The client executes an authorized action. The Router only transports the call
  and correlates the result with the same provider run.

Model suggestions such as "should I update this in Notion?" are ordinary text.
The Router intervenes only when an actual tool invocation exists; confirmation
UI and UX belong to CMMChat.

### AGENT

The harness/agent profile, and the generalization of the historical
`CMM Code Router`.

- The **client or harness owns tool execution**; the **provider owns reasoning
  only**.
- Tool calls are surfaced to the client and results return to the same logical
  provider run where the provider supports it.
- The harness-supplied tool set is transported subject to provider/model
  structured-tool capability, protocol representability and the existing
  security invariants. AGENT still never executes a tool in the Router.
- Client identity grants nothing: a Qoder, Hermes or Codex request is AGENT
  because of the bearer it presents, not because of its name.

`CMM Code Router` is retained as the historical/compatibility identity of the
AGENT profile. It is not a third profile and not a security primitive.

## Architecture

```text
client / harness
      │  OpenAI-compatible HTTP, loopback only
      ▼
CMM Routers  ──►  ProviderRegistry  ──►  provider adapter
      │                                      │
      │  profile → effective tool policy     ▼
      │                              subscription-backed provider
      ▼
shared tool transport / correlation engine
```

Two responsibilities are kept strictly apart:

- **Reasoning** happens upstream, in the subscription-backed provider.
- **Tool execution** happens in the client/harness, on the user's own machine.

The router binds only to `127.0.0.1` and never to a routable interface. It is a
translation and correlation layer, not an execution environment: it forwards a
tool call outward and accepts the result back, but it never runs the tool itself.

## Supported providers

| Provider | Models | Authentication | Tool channel (AGENT / granted CHAT) |
|---|---|---|---|
| ChatGPT / Codex | `chatgpt/*` | `codex login` (ChatGPT subscription) | Supported and live-verified |
| Claude | `claude/*` | Isolated profile via `CLAUDE_CONFIG_DIR` | Supported and live-verified |
| Google / Antigravity | `google/*` | Google account via `agy` | Supported and live-verified |
| Command Code | `command-code/*` | Local secret plus explicit human spend acknowledgement | Wired and covered by deterministic tests; the provider ships **disabled** and live enablement is not yet complete |

Model namespaces are resolved exactly. An unknown prefix fails closed instead of
guessing a provider, and no provider may be substituted for another.

Command Code is intentionally off by default. Enabling it requires an explicit
human spend acknowledgement that is never created on anyone's behalf.

## Security invariants

These are enforced, not aspirational:

- **No API PAYG fallback.** A subscription route never silently degrades into a
  metered API call. Pay-as-you-go environment variables cause preflight to fail
  closed, and each provider strips them from its child environment.
- **No cross-provider fallback.** A request stays with the provider it addressed.
- **No unknown-model fallback.** A model that is not discovered fails closed.
- **Loopback only.** The router binds `127.0.0.1` and never `0.0.0.0`.
- **Local credentials.** Secrets live in the environment or the macOS Keychain —
  never in Git, logs, fixtures, or synced config.
- **No tracked secrets.**
- **No provider-native repository mutation.** Providers reason; they do not edit.
- **Profile comes from authentication, not identity.** A header, model name,
  client name, tool name or body claim can never select `AGENT` or widen a grant.
- **CHAT fails closed.** No default tools; registered + granted scoped actions
  only; any out-of-scope tool rejects the request instead of being stripped.
- **One shared tool engine.** CHAT scoped actions and AGENT tool loops use the
  same transport/correlation path; the difference is the policy applied first.
- **Logging hygiene.** Prompts, completions, tool arguments, and tool results are
  never logged in normal runtime.

## Supported clients

Any client that can speak to an OpenAI-compatible HTTP endpoint can consume
CMM Routers.

- **CMMChat** — authenticates as `CHAT` with `CMM_ROUTER_TOKEN`. Conversation,
  streaming, multimodal input and reasoning, plus only explicitly granted
  scoped actions.
- **Qoder** — an `AGENT` consumer, authenticated with its legacy
  `CMM_QODER_TOKEN`. Qoder is a supported client of the project, not the identity
  of the project or of the profile; it owns and executes the tools it is given.
- **Hermes**, the **Codex CLI** and generic OpenAI-compatible agents — further
  `AGENT` consumers authenticated with `CMM_CODE_ROUTER_TOKEN` (or the legacy
  Qoder alias where already installed). Each is configured as an ordinary
  OpenAI-compatible client; none is an authorization role.

The architecture is open to additional compatible clients and harnesses. A client
NAME never creates a new capability: the bearer decides the profile. Real-client
verification status per client is stated in
[capability and real-client status](docs/code-router-capability-status.md).

See [CMM Code Router — generic client setup](docs/code-router-setup.md) for the
client-agnostic protocol, and [Router profiles](docs/router-profiles.md) for the
CHAT/AGENT model.

## Credentials

Authenticate tool-owning clients with the canonical `AGENT` bearer:

```text
CMM_CODE_ROUTER_TOKEN
```

`CMM_QODER_TOKEN` remains a legacy compatibility alias for the SAME `AGENT`
profile. The CMMChat bearer (`CMM_ROUTER_TOKEN`) authenticates the separate
`CHAT` profile, which carries no caller-supplied tools. See
[migration](docs/code-router-migration.md).

## Setup

### Install and run locally

```bash
npm install
npm run build
bash scripts/preflight.sh
npm start
```

The canonical checkout path is `$HOME/CMM-Routers`. Preflight prints status lines
only and never prints secret values; it fails the run on unsafe PAYG state.

The router binds `127.0.0.1:8790`.

### Credentials

Provide the router bearer through the environment or the macOS Keychain. See
[docs/macos-install.md](docs/macos-install.md) for the LaunchAgent installation,
the Keychain commands, and the per-machine reproducibility notes.

When no AGENT bearer is configured, there is no AGENT consumer: every
authenticated inference client is `CHAT`. `CMM_QODER_TOKEN` continues to work
for installed Qoder setups; `CMM_CODE_ROUTER_TOKEN` is the canonical AGENT
alias. Both resolve to the same AGENT profile. A CHAT token is never accepted as
a fallback for AGENT, and no token is copied, generated or migrated.

See [docs/router-profiles.md](docs/router-profiles.md) for the policy contract,
the scoped-action model and the legacy mapping.

### Qoder

See [docs/qoder-setup.md](docs/qoder-setup.md) for the provider registration and
the validation order, and [docs/qoder-acceptance.md](docs/qoder-acceptance.md)
for the acceptance criteria.

If you edit `~/.qoder/settings.json` outside Qoder, **quit Qoder completely and
relaunch it** before the UI will reflect updated model metadata. A window reload
is not enough. Never commit that settings file: it may hold plaintext
credentials.

## Current and legacy identifiers

Current-facing identifiers:

| Identifier | Purpose |
|---|---|
| `CMM_CODE_ROUTER_TOKEN` | Canonical Code Router bearer (profile credential) |
| `code-router-bearer` | macOS Keychain account for the canonical bearer |
| `CMM_CODE_ROUTER_KEYCHAIN_SERVICE`, `CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT` | Keychain lookup overrides |

Some internal identifiers still carry the project's earlier name. These are
**legacy compatibility identifiers**, not current branding, and they are retained
on purpose so existing installations keep working without migration.

| Identifier | Purpose |
|---|---|
| `com.cmm.subscription-router` | LaunchAgent label |
| `launchd/com.cmm.subscription-router.plist.template` | plist template filename |
| `cmm-subscription-router` | macOS Keychain service |
| `router-bearer`, `qoder-bearer`, `code-router-bearer`, `command-code-secret` | Keychain account names (`code-router-bearer` is optional; nothing creates it automatically) |
| `qoder-custom-cmm-router` | Qoder provider ID |
| `CMM_ROUTER_TOKEN` | CHAT profile bearer |
| `CMM_CODE_ROUTER_TOKEN` | canonical AGENT profile bearer |
| `CMM_QODER_TOKEN` | legacy Qoder alias for the AGENT profile |
| `CHAT_ONLY`, `CHAT_AND_TOOLS` | provider/model capability representation (not profile names) |
| `CMM Code Router` | historical/compatibility name of the AGENT profile |
| `cmm-qoder-tools`, `mcp__cmm_qoder__`, `cmm_qoder` | MCP bridge / registration names |
| `~/Library/Logs/CMM-Subscription-Router/` | Local log directory |

Renaming any of these would break an installed LaunchAgent, orphan stored
Keychain items, detach an already-registered Qoder provider, or invalidate a
persisted MCP registration — all for purely cosmetic gain. `mcp(cmm-qoder-tools/*)`
is additionally an active security scope and must never be widened. Historical
audit records and earlier evidence documents likewise keep the names that were
accurate when they were written.

## Verification

```bash
npm run build
npx vitest run
npm run typecheck
bash scripts/security-audit.sh
```

- `npx vitest run` — full deterministic suite. Live provider canaries that
  consume subscription quota are separate and remain explicit, manual, and
  gated; they never run as part of a normal test pass.
- `npm run typecheck` — TypeScript, no emit.
- `bash scripts/security-audit.sh` — fail-closed routing and security
  invariants, including no PAYG or cross-provider escalation and no CMMChat
  tool escalation.
- `bash scripts/preflight.sh` — provider authentication and PAYG-safety status.

## Roadmap

CMM Routers will remain pre-stable until the current provider set is proven end-to-end in real clients and the catalog/runtime architecture is ready to evolve with upstream providers.

### 1. Close current compatibility gaps

- Finish live tool compatibility for the remaining Google/Antigravity edge cases, including GPT-OSS and real Qoder tool selection.
- Revalidate ChatGPT/Codex when subscription quota is available.
- Complete Command Code live enablement only after an explicit human spend decision.
- Complete multi-Mac Qoder synchronization and the final real-Qoder compatibility gate.
- Treat models that require optional paid credits as discoverable catalog entries even when local credit use is disabled; billing availability is separate from catalog truth.

### 2. Make provider catalogs dynamic

The provider is the source of truth for which models exist. CMM Routers is the source of truth for how those models are exposed safely and truthfully to consumers.

- Reflect provider model additions, removals, aliases, and relevant metadata changes automatically.
- Replace the current fixed managed-model layout with namespace-aware reconciliation.
- Keep provider discovery, Router capability truth, live compatibility status, and local billing availability as separate concerns.
- Reconcile CMM-managed models into Qoder without deleting or rewriting legitimate unmanaged user models.
- Never enable PAYG, paid-credit usage, cross-provider fallback, or unknown-model fallback implicitly.

### 3. Normalize the local repository path

- Rename the local checkout from `$HOME/CMM-Routers` to `$HOME/CMM Routers`.
- Repair all path-bound local integrations, including launchd, AGY MCP registration, scripts, tests, and Qoder-facing configuration.
- Prove that no active runtime dependency still points to the old local path.
- Keep the GitHub repository slug hyphenated where spaces are impractical.

### 4. Expand provider support

- Add additional compatible subscription providers one at a time through the same provider contract.
- Require truthful discovery, capability mapping, secure credential handling, fail-closed routing, and client-owned tool round-trips where supported.
- Keep Qoder as a supported client/harness rather than making any single client the identity of CMM Routers.

### 5. Stable public release

A stable tag is created only after:

- the current provider compatibility matrix is green or explicitly truthful about unsupported capabilities;
- dynamic provider catalog reconciliation is proven;
- the local path migration is complete and audited;
- the intended provider expansion for the target release is complete;
- build, tests, typecheck, security audit, privacy/secret checks, public export verification, and real-client compatibility gates pass.

Until then, public `main` remains pre-stable.
## Safe public maintenance

Public updates are prepared through a one-way sanitization pipeline that keeps the private development history separate from the public Git history. Preparation, guarded push, and fresh-clone verification are separate fail-closed steps.

See [Safe public publication workflow](docs/publication.md) for the maintenance procedure and safety gates.
