# macOS Install — CMM Subscription Router

## MacBook (this machine)

```bash
bash scripts/preflight.sh
npm run build
bash scripts/macos/install-router.sh
launchctl load ~/Library/LaunchAgents/com.cmm.subscription-router.plist
curl -s http://127.0.0.1:8790/health
```

The service binds only `127.0.0.1:8790`, starts at login, and restarts
on unexpected failure with a 30s throttle (no restart storms).

Secrets resolve from macOS Keychain at startup via
`scripts/macos/run-router.sh`. No secret is embedded in the plist.

Store secrets once (values never echoed):

```bash
security add-generic-password -s cmm-subscription-router -a router-bearer -w
security add-generic-password -s cmm-subscription-router -a command-code-secret -w
```

## iMac reproducibility

On the iMac (`/Users/christian/CMM-Subscription-Router` or the actual
intended path):

1. Clone/pull the same Git revision.
2. Run `bash scripts/preflight.sh` and `npm run build`.
3. Store that Mac's own secrets in its Keychain (same commands as above).
4. Run `bash scripts/macos/install-router.sh`.
5. Re-authenticate each provider locally on the iMac.

Do NOT copy between Macs:

- Codex OAuth / `~/.codex` auth
- Claude profile credentials
- Google OAuth / Antigravity credentials
- Keychain secrets
- router bearer token
- local config

Shared config contains no secrets. Each Mac works offline from the other.

`IMAC_LIVE_INSTALL=BLOCKED_EXTERNAL_PRECONDITION` — the iMac itself is
not reachable from this environment; `IMAC_REPRODUCIBILITY=PASS` via
installer generation and dry-run tested here
(`tests/integration/launchagent.test.ts`).
