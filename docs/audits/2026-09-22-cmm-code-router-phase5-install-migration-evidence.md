# CMM Code Router — Phase 5 Implementation Evidence (Docs / Install / Migration)

**Date:** 2026-09-22
**Nature:** Implementation evidence. Historical audits are not rewritten.

## What changed

| Commit | Content |
|---|---|
| `23bc3ee` | `feat: wire the canonical Code Router bearer into the install path` |
| `cc9cd37` | `docs: document canonical bearer provisioning, migration and truthful status` |

### Install path (additive only)

- `launchd/com.cmm.subscription-router.plist.template` gains
  `CMM_CODE_ROUTER_KEYCHAIN_SERVICE` / `CMM_CODE_ROUTER_KEYCHAIN_ACCOUNT`
  (identifiers only; the template still embeds no secret value).
- `scripts/macos/run-router.sh` resolves `CMM_CODE_ROUTER_TOKEN` from the
  configured Keychain pair. Resolution is **non-fatal**: the final fail-closed
  check still requires only the CMMChat bearer, so existing installs keep
  starting.
- `scripts/macos/install-router.sh` reports whether `code-router-bearer` exists
  and prints the provisioning command; it never creates the item and never
  prints a value (idempotent, same treatment as the legacy alias).
- The LaunchAgent label and Keychain service are unchanged.

### Documentation

- `docs/macos-install.md`: canonical bearer first, legacy bearer reframed as a
  compatibility alias, fail-closed collision rule stated, and the false doctrine
  ("the Qoder bearer is what enables the Code Router profile") removed.
- `docs/code-router-migration.md` (new): two profiles, the deterministic
  precedence table, the never-rename list, and the criteria for closing the
  compatibility window.
- `docs/code-router-capability-status.md` (new): truthful proven/pending/blocked
  status per provider and client, including that `google/*` multi-step and
  GPT-OSS remain unproven and that Task 16/16B are blocked on a missing
  prerequisite.
- `README.md`: canonical identifiers table added, legacy identifiers kept and
  extended, supported-client section updated.

## Verification

| Gate | Result |
|---|---|
| `tests/integration/code-router-bearer-provisioning.test.ts` (new) | PASS (5) |
| `tests/integration/qoder-bearer-provisioning.test.ts` | PASS |
| `tests/integration/launchagent.test.ts` | PASS |
| `tests/integration/cmm-routers-branding.test.ts` | PASS |
| `tests/config/env-example.test.ts` | PASS |
| `npm run typecheck` | PASS |
| `bash scripts/security-audit.sh` | `SECURITY_AUDIT=PASS` |

`launchd-deterministic` / `launchd-fail-closed` remain in the known
environmental failure family (the installer cannot resolve `codex`/`agy` on this
machine); they fail identically on the untouched baseline.

## Evidence markers

```text
CANONICAL_CODE_ROUTER_AUTH_INSTALL_PATH=PASS
CODE_ROUTER_KEYCHAIN_IDENTIFIERS_PRESENT=PASS
CODE_ROUTER_BEARER_INSTALLER_REPORT=PASS
LEGACY_QODER_AUTH_COMPATIBILITY=PASS
CMMCHAT_AUTH_SEPARATION=PASS
PERSISTED_LEGACY_NAMES_PRESERVED=YES
TRACKED_SECRETS=NONE
```

## Not done (deliberately)

- The `$HOME/CMM-Routers` -> `$HOME/CMM Routers` path migration is out of scope.
- No persisted MCP/ACL identity was renamed.
- Preflight bearer *presence* reporting was left out rather than destabilizing the
  preflight tests, which are already load-sensitive on this machine; it remains a
  small, independent future task.
