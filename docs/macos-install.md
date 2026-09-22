# macOS Install — CMM Routers

The canonical checkout path is `$HOME/CMM-Routers`.

## Install on this machine

```bash
bash scripts/preflight.sh
npm run build
bash scripts/macos/install-router.sh
launchctl load ~/Library/LaunchAgents/com.cmm.subscription-router.plist
curl -s http://127.0.0.1:8790/health
```

The LaunchAgent label `com.cmm.subscription-router` is a **legacy compatibility
identifier**. It is intentionally not renamed, so an already-installed service
keeps working without uninstall/reinstall churn.

The service binds only `127.0.0.1:8790`, starts at login, and restarts
on unexpected failure with a 30s throttle (no restart storms).

Secrets resolve from macOS Keychain at startup via
`scripts/macos/run-router.sh`. No secret is embedded in the plist.

Store secrets once (values never echoed). `cmm-subscription-router` here is the
**legacy compatibility Keychain service ID**, not current product branding —
renaming it would orphan the stored items for existing installations:

```bash
security add-generic-password -s cmm-subscription-router -a router-bearer -w
security add-generic-password -s cmm-subscription-router -a command-code-secret -w
```

### Code Router bearer (canonical)

The Code Router profile (`CHAT_AND_TOOLS`) is what serves tool-owning clients —
Qoder, Hermes, Codex and any generic OpenAI-compatible harness. It is
client-agnostic: the bearer authenticates the **profile**, not an application.
Provision the canonical item per Mac (never copied between machines, never
committed):

```bash
security add-generic-password -s cmm-subscription-router -a code-router-bearer -w
```

At startup `scripts/macos/run-router.sh` reads
`service=cmm-subscription-router account=code-router-bearer` from Keychain and
exports it as `CMM_CODE_ROUTER_TOKEN`. `scripts/macos/install-router.sh` reports
whether the item already exists and, if not, prints the exact provisioning
command (idempotent; it never overwrites and never prints a value).

### Legacy Qoder bearer (compatibility alias)

The Qoder bearer is retained as an explicit **compatibility alias** for the same
Code Router profile, so existing installations keep working without migration.
It is no longer a distinct role and it never authenticates CMMChat. Provision it
per Mac if it is not already present:

```bash
security add-generic-password -s cmm-subscription-router -a qoder-bearer -w
```

At startup the wrapper exports it as `CMM_QODER_TOKEN`. Either Code Router
credential — canonical or legacy — authenticates the Code Router profile; when
neither is present there is simply no Code Router profile and every
authenticated client is CMMChat, which is permanently CHAT_ONLY. Values are read
without echo and never written to the plist, logs, or the repository.

Configuration collisions fail closed: if the CMMChat bearer equals either Code
Router bearer the Router refuses to start rather than resolving an ambiguous
profile.

## Reproducing the install on another Mac

From `$HOME/CMM-Routers` on the second machine:

1. Clone/pull the same Git revision.
2. Run `bash scripts/preflight.sh` and `npm run build`.
3. Store that Mac's own secrets in its Keychain (same commands as above),
   including `code-router-bearer` for the Code Router profile and, while the
   compatibility window is open, `qoder-bearer` for the legacy alias.
4. Run `bash scripts/macos/install-router.sh`.
5. Re-authenticate each provider locally on that Mac.

Do NOT copy between Macs:

- Codex OAuth / `~/.codex` auth
- Claude profile credentials
- Google OAuth / Antigravity credentials
- Keychain secrets
- router bearer token
- local config

Shared config contains no secrets. Each Mac works offline from the other.

A second-machine live install cannot be proven from a single-machine
environment, so it is reported as `BLOCKED_EXTERNAL_PRECONDITION` rather than
claimed. Installer generation and dry-run behaviour are covered deterministically
by `tests/integration/launchagent.test.ts`.
