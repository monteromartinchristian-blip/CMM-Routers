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

CMM Routers exposes two product profiles. The profile is decided by the consumer
that connects, not by which provider is selected.

### CMMChat Router — `CHAT_ONLY`

The conversational profile.

- Never gains tools, shell access, filesystem access, or repository mutation.
- Stays `CHAT_ONLY` even when the selected provider and model are technically
  capable of tool calling.
- Intended for CMMChat and equivalent chat-only consumers.

### CMM Code Router — `CHAT_AND_TOOLS`

The coding/agent profile.

- The **client or harness owns tool execution**.
- The **provider owns reasoning only**.
- Tool calls are surfaced back to the client/harness, and tool results return to
  the same logical provider run where the provider supports it.
- Providers never mutate a repository directly.

`CMM Code Router` is advertised only where the selected provider and model
truthfully support the externally-owned tool round-trip. Where a route does not
support it, the router says so rather than faking capability.

## Architecture

```text
client / harness
      │  OpenAI-compatible HTTP, loopback only
      ▼
CMM Routers  ──►  ProviderRegistry  ──►  provider adapter
                                            │
                                            ▼
                                  subscription-backed provider
```

Two responsibilities are kept strictly apart:

- **Reasoning** happens upstream, in the subscription-backed provider.
- **Tool execution** happens in the client/harness, on the user's own machine.

The router binds only to `127.0.0.1` and never to a routable interface. It is a
translation and correlation layer, not an execution environment: it forwards a
tool call outward and accepts the result back, but it never runs the tool itself.

## Supported providers

| Provider | Models | Authentication | CMM Code Router tool channel |
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
- **Logging hygiene.** Prompts, completions, tool arguments, and tool results are
  never logged in normal runtime.

## Supported clients

Any client that can speak to an OpenAI-compatible HTTP endpoint can consume
CMM Routers.

- **CMMChat** — the `CHAT_ONLY` consumer.
- **Qoder** — the first documented `CMM Code Router` consumer. Qoder is a
  supported client of the project, not the identity of the project or of the
  profile; Qoder owns and executes the tools it is given.

The architecture is open to additional compatible clients and harnesses.

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

When the optional Qoder consumer bearer is absent, there is simply no
`CMM Code Router` consumer: every authenticated client is treated as CMMChat and
stays permanently `CHAT_ONLY`.

### Qoder

See [docs/qoder-setup.md](docs/qoder-setup.md) for the provider registration and
the validation order, and [docs/qoder-acceptance.md](docs/qoder-acceptance.md)
for the acceptance criteria.

If you edit `~/.qoder/settings.json` outside Qoder, **quit Qoder completely and
relaunch it** before the UI will reflect updated model metadata. A window reload
is not enough. Never commit that settings file: it may hold plaintext
credentials.

## Legacy compatibility identifiers

Some internal identifiers still carry the project's earlier name. These are
**legacy compatibility identifiers**, not current branding, and they are retained
on purpose so existing installations keep working without migration.

| Identifier | Purpose |
|---|---|
| `com.cmm.subscription-router` | LaunchAgent label |
| `launchd/com.cmm.subscription-router.plist.template` | plist template filename |
| `cmm-subscription-router` | macOS Keychain service |
| `router-bearer`, `qoder-bearer`, `command-code-secret` | Keychain account names |
| `qoder-custom-cmm-router` | Qoder provider ID |
| `CMM_ROUTER_TOKEN`, `CMM_QODER_TOKEN` | Environment variable names |
| `~/Library/Logs/CMM-Subscription-Router/` | Local log directory |

Renaming any of these would break an installed LaunchAgent, orphan stored
Keychain items, or detach an already-registered Qoder provider — all for purely
cosmetic gain. Historical audit records and earlier evidence documents likewise
keep the names that were accurate when they were written.

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

- Additional clients and harnesses on the `CMM Code Router` profile.
- Command Code live enablement, gated on an explicit human spend decision.
- Multi-Mac Qoder model synchronization.
- Additional compatible subscription providers.

## Safe public maintenance

Public updates are prepared through a one-way sanitization pipeline that keeps the private development history separate from the public Git history. Preparation, guarded push, and fresh-clone verification are separate fail-closed steps.

See [Safe public publication workflow](docs/publication.md) for the maintenance procedure and safety gates.
