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

### Qoder consumer bearer (optional)

The Qoder consumer is what enables the `CMM Code Router` profile, in which Qoder
owns and executes tools. It is enabled only when its own bearer is present.
Provision it per Mac (never copied between machines, never committed):

```bash
security add-generic-password -s cmm-subscription-router -a qoder-bearer -w
```

At startup `scripts/macos/run-router.sh` reads
`service=cmm-subscription-router account=qoder-bearer` from Keychain and exports
it as `CMM_QODER_TOKEN`. When absent there is simply no Qoder consumer: every
authenticated client is CMMChat, which is permanently CHAT_ONLY. The value is
read without echo and never written to the plist, logs, or the repository.
`scripts/macos/install-router.sh` reports whether the item already exists and,
if not, prints the exact provisioning command (idempotent; it never overwrites).

## Reproducing the install on another Mac

From `$HOME/CMM-Routers` on the second machine:

1. Clone/pull the same Git revision.
2. Run `bash scripts/preflight.sh` and `npm run build`.
3. Store that Mac's own secrets in its Keychain (same commands as above),
   including `qoder-bearer` if that Mac should serve the Qoder consumer.
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
